import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseGuardianAssessment } from "./assessment.ts";
import { CONTEXT_COMMAND, DEFAULT_CONTEXT, envelopeText, type ReviewContext } from "./reviewer-context.ts";
import type { GuardianAssessment, GuardianConfig, GuardianStateV1 } from "./types.ts";
import { parseUsageSnapshot, type GuardianUsageNotice } from "./usage.ts";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
interface PiInvocation { command: string; args: string[] }
export function getPiInvocation(args: string[], configuredCommand?: string): PiInvocation {
	if (configuredCommand) return { command: configuredCommand, args };
	// The subagent bootstrap is not the Pi CLI; never recursively invoke it with CLI flags.
	if (isNestedSubagentProcess()) return { command: process.env.PI_SUBAGENT_PI_BINARY?.trim() || "pi", args };
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())) return { command: process.execPath, args };
	return { command: "pi", args };
}
function isNestedSubagentProcess(): boolean {
	return process.env.PI_ASYNC_NATIVE_RUNNER === "1" || Boolean(process.env.PI_SUBAGENT_RUNNER_CONFIG) ||
		Boolean(process.argv[1] && /(?:^|[\\/])(?:subagent-runner(?:-bootstrap)?|binary-bootstrap|inspector-runner)\.(?:mjs|cjs|js|ts)$/i.test(process.argv[1]));
}
export function buildSidecarArgs(config: GuardianConfig, _state: GuardianStateV1): string[] {
	// The CLI is only a portable bootstrap. The internal SDK runner alone owns the durable session.
	const args = ["--mode", "json", "--print", "--no-session", "--model", config.reviewerModel, "--thinking", config.thinkingLevel,
		"--system-prompt", config.policyPath, "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-context-files", "--no-themes", "--no-approve", "--extension", fileURLToPath(new URL("./managed-reviewer.ts", import.meta.url))];
	for (const extension of config.reviewerExtensions ?? []) args.push("--extension", extension);
	return args;
}

async function runSidecar(config: GuardianConfig, state: GuardianStateV1, prompt: string, timeoutMs: number, signal: AbortSignal | undefined, nonce: string, reportUsage?: (notice: GuardianUsageNotice) => void): Promise<GuardianAssessment> {
	const invocation = getPiInvocation(buildSidecarArgs(config, state), config.piCommand);
	reportUsage?.({ kind: "pending", parentSessionId: state.parentSessionId, requestId: nonce });
	return await new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, { cwd: process.cwd(), shell: false, stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "", stderr = "";
		let result: GuardianAssessment | undefined;
		let failure: Error | undefined;
		let settled = false;
		let usageReported = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			if (child.exitCode !== null || child.signalCode !== null || killTimer) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5_000);
			killTimer.unref();
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			try { if (!usageReported) reportUsage?.({ kind: "gap", parentSessionId: state.parentSessionId, requestId: nonce }); }
			catch (cause) { failure ??= cause instanceof Error ? cause : new Error(String(cause)); }
			if (error || failure) reject(failure ?? error);
			else if (!result) reject(new Error(`Guardian produced no verified managed response${stderr ? `: ${stderr.trim()}` : ""}`));
			else resolve(result);
		};
		const consume = (line: string) => {
			let event: Record<string, unknown>;
			try { event = JSON.parse(line); } catch { return; } // Non-JSON diagnostics never establish success.
			if (!event || typeof event !== "object" || Array.isArray(event)) return;
			// Pi protects JSON stdout: extension output travels through its native entry event.
			if (event.type === "entry_appended") {
				const entry = event.entry as { customType?: string; data?: Record<string, unknown> } | undefined;
				if ((entry?.customType === "pi-guardian.managed-result" || entry?.customType === "pi-guardian.managed-usage") && entry.data) event = entry.data;
			}
			if (event.type === "guardian_usage" && event.nonce === nonce) {
				try {
					if (usageReported) throw new Error("Guardian returned duplicate usage telemetry");
					const snapshot = parseUsageSnapshot(event.usage);
					if (snapshot.parentSessionId !== state.parentSessionId || snapshot.reviewerSessionId !== state.guardianSessionId) throw new Error("Guardian usage identity mismatch");
					reportUsage?.({ kind: "snapshot", snapshot, requestId: nonce });
					usageReported = true;
				} catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
			}
			if (event.type === "guardian_review_result" && event.nonce === nonce) {
				try {
					if (result) throw new Error("Guardian returned duplicate managed results");
					if (typeof event.error === "string") throw new Error(event.error);
					result = parseGuardianAssessment(JSON.stringify(event.assessment));
				} catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
			}
			if (event.type === "message_end") {
				const message = event.message as Record<string, unknown> | undefined;
				if (message?.stopReason === "error" || message?.stopReason === "aborted") failure = new Error(`Guardian reviewer request failed: ${message.errorMessage ?? message.stopReason}`);
			}
		};
		const abort = () => stop(new Error("Guardian review was aborted"));
		const timer = setTimeout(() => stop(new Error(`Guardian review timed out after ${timeoutMs}ms`)), timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (settled || failure) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MAX_CAPTURE_BYTES) { buffer = ""; stop(new Error("Guardian output exceeded the capture limit")); return; }
			const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) consume(line);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { if (Buffer.byteLength(stderr) < MAX_CAPTURE_BYTES) stderr += chunk; });
		child.on("error", (error) => {
			const failed = new Error(`Guardian sidecar process error: ${error.message}`);
			// Spawn failure has no writer. Runtime/kill errors do not prove that a
			// launched writer terminated; retain ownership until its close event.
			if (child.pid === undefined) finish(failed); else stop(failed);
		});
		child.on("close", (code, childSignal) => {
			if (buffer.trim()) consume(buffer);
			finish(code === 0 ? undefined : new Error(`Guardian sidecar exited ${childSignal ? `with signal ${childSignal}` : `with code ${String(code)}`}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
		// A timeout/abort does not release session ownership until close confirms termination.
		if (signal?.aborted) { abort(); return; }
		signal?.addEventListener("abort", abort, { once: true });
		child.stdin.on("error", (error) => stop(new Error(`Could not send Guardian prompt: ${error.message}`)));
		child.stdin.end(prompt);
	});
}

// All callers, including sandbox exception reviews, share this coordinator.
const reviewerTails = new Map<string, Promise<void>>();
export async function requestGuardianAssessment(config: GuardianConfig, state: GuardianStateV1, prompt: string, signal?: AbortSignal,
	context: ReviewContext = { directives: [], evidence: [], action: prompt }, validate?: () => void, reportUsage?: (notice: GuardianUsageNotice) => void): Promise<GuardianAssessment> {
	const deadline = Date.now() + config.timeoutMs;
	const key = JSON.stringify([state.guardianSessionDir, state.guardianSessionId]);
	const previous = reviewerTails.get(key) ?? Promise.resolve();
	const work = previous.then(async () => {
		if (signal?.aborted) throw new Error("Guardian review was aborted");
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new Error(`Guardian review timed out after ${config.timeoutMs}ms while queued`);
		validate?.(); // Queued/speculative evidence must still belong to the active parent state.
		const nonce = randomUUID();
		const input = { version: 1, nonce, sessionId: state.guardianSessionId, sessionDir: state.guardianSessionDir, parentSessionId: state.parentSessionId,
			agentDir: config.agentDir, policyPath: config.policyPath, policyHash: state.policyHash, model: config.reviewerModel, thinking: config.thinkingLevel,
			extensions: [...(config.reviewerExtensions ?? [])], options: config.reviewerContext ?? DEFAULT_CONTEXT, maxAttempts: config.maxAttempts,
			prompt: envelopeText(state.parentSessionId, state.policyHash, prompt, context) };
		const result = await runSidecar(config, state, `/${CONTEXT_COMMAND} ${JSON.stringify(input)}`, remainingMs, signal, nonce, reportUsage);
		validate?.();
		return result;
	});
	const tail = work.then(() => {}, () => {});
	reviewerTails.set(key, tail);
	try { return await work; }
	finally { if (reviewerTails.get(key) === tail) reviewerTails.delete(key); }
}
