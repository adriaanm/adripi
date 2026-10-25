import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { parseGuardianAssessment } from "./assessment.ts";
import { buildFormatRetryPrompt } from "./prompt.ts";
import type { GuardianAssessment, GuardianConfig, GuardianStateV1 } from "./types.ts";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

interface PiInvocation {
	command: string;
	args: string[];
}

interface SidecarTurnResult {
	text: string;
	stderr: string;
}

export function getPiInvocation(args: string[], configuredCommand?: string): PiInvocation {
	if (configuredCommand) return { command: configuredCommand, args };
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function buildSidecarArgs(config: GuardianConfig, state: GuardianStateV1): string[] {
	const args = [
		"--mode",
		"json",
		"--print",
		"--session-dir",
		state.guardianSessionDir,
		"--session-id",
		state.guardianSessionId,
		"--model",
		config.reviewerModel,
		"--thinking",
		config.thinkingLevel,
		"--system-prompt",
		config.policyPath,
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--no-approve",
	];
	for (const extension of config.reviewerExtensions) {
		args.push("--extension", extension);
	}
	if (state.reviewCount === 0) args.push("--name", `Guardian for ${state.parentSessionId.slice(0, 12)}`);
	return args;
}

function assistantTextFromEvent(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const record = event as Record<string, unknown>;
	if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return undefined;
	const message = record.message as Record<string, unknown>;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter(
			(item): item is { type: "text"; text: string } =>
				Boolean(item) &&
				typeof item === "object" &&
				(item as Record<string, unknown>).type === "text" &&
				typeof (item as Record<string, unknown>).text === "string",
		)
		.map((item) => item.text)
		.join("");
	return text || undefined;
}

async function runSidecarTurn(
	config: GuardianConfig,
	state: GuardianStateV1,
	prompt: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<SidecarTurnResult> {
	const invocation = getPiInvocation(buildSidecarArgs(config, state), config.piCommand);
	return await new Promise<SidecarTurnResult>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: process.cwd(),
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let stderr = "";
		let latestAssistantText: string | undefined;
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const stopChild = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 5_000);
			killTimer.unref();
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else if (!latestAssistantText) reject(new Error(`Guardian produced no assistant response${stderr ? `: ${stderr.trim()}` : ""}`));
			else resolve({ text: latestAssistantText, stderr });
		};
		const onAbort = () => {
			stopChild();
			finish(new Error("Guardian review was aborted"));
		};
		const timeout = setTimeout(() => {
			stopChild();
			finish(new Error(`Guardian review timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_CAPTURE_BYTES) {
				stopChild();
				finish(new Error("Guardian output exceeded the capture limit"));
				return;
			}
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					latestAssistantText = assistantTextFromEvent(JSON.parse(line)) ?? latestAssistantText;
				} catch {
					// Pi startup diagnostics may be non-JSON. The process exit and assistant event remain authoritative.
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (Buffer.byteLength(stderr, "utf8") < MAX_CAPTURE_BYTES) stderr += chunk;
		});
		child.on("error", (error) => finish(new Error(`Could not start Guardian sidecar: ${error.message}`)));
		child.on("close", (code, childSignal) => {
			if (killTimer) clearTimeout(killTimer);
			if (stdoutBuffer.trim()) {
				try {
					latestAssistantText = assistantTextFromEvent(JSON.parse(stdoutBuffer)) ?? latestAssistantText;
				} catch {
					// Ignore a trailing non-JSON diagnostic.
				}
			}
			if (code !== 0) {
				finish(
					new Error(
						`Guardian sidecar exited ${childSignal ? `with signal ${childSignal}` : `with code ${String(code)}`}${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
				return;
			}
			finish();
		});

		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.on("error", (error) => finish(new Error(`Could not send Guardian prompt: ${error.message}`)));
		child.stdin.end(prompt);
	});
}

export async function requestGuardianAssessment(
	config: GuardianConfig,
	state: GuardianStateV1,
	prompt: string,
	signal?: AbortSignal,
): Promise<GuardianAssessment> {
	let nextPrompt = prompt;
	let lastError: Error | undefined;
	const deadline = Date.now() + config.timeoutMs;
	for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new Error(`Guardian review timed out after ${config.timeoutMs}ms`);
		const result = await runSidecarTurn(config, state, nextPrompt, remainingMs, signal);
		try {
			return parseGuardianAssessment(result.text);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			nextPrompt = buildFormatRetryPrompt(lastError.message);
		}
	}
	throw new Error(`Guardian returned malformed output after ${config.maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`);
}
