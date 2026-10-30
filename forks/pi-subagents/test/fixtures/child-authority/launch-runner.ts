// Real Node IPC fixture for the guarded runner launch path.
//
// It binds the lease the host prepared for this process exactly as the detached runner does
// (`bindRunnerChildAuthority`), then drives the production `runChildSession` gate with a controlled
// code-only consumer instead of a Pi SDK session. Nothing here stands in for pi-sbx or Guardian:
// the consumers only claim and acknowledge the lease the host actually sent.
import * as fs from "node:fs";
import * as path from "node:path";
import { runChildSession } from "../../../src/runs/background/run-child-session.ts";
import { acknowledgeChildAuthority, claimChildAuthority } from "../../../src/runs/shared/child-authority.ts";
import { bindRunnerChildAuthority } from "../../../src/runs/shared/child-authority-launch.ts";
import type { ChildSessionFactory } from "../../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../../src/runs/shared/child-launch.ts";

interface RunnerFixtureConfig {
	/** The serialized runner-config marker; a writable config may add it, never remove the channel requirement. */
	request?: unknown;
	runId?: string;
	agent: string;
	index: number;
	cwd: string;
	prompt?: string;
	/** Claim and acknowledge these consumers while the host loads the child. */
	consumers?: string[];
	/** Claim only these, never acknowledge: the readiness negative. */
	claimOnly?: string[];
	/** Hold the first prompt open until the session is aborted: the parent-loss negative. */
	hangUntilAbort?: boolean;
	/** Attempt real nested launches from inside this guarded runner after it binds its lease. */
	nested?: { runId: string; foregroundAgent: string; backgroundAgent: string; disposeFirst?: boolean };
}

const config = JSON.parse(process.argv[2] ?? "{}") as RunnerFixtureConfig;
const events: Array<Record<string, unknown>> = [];
const waiters: Array<() => void> = [];

/** One recorded step, also appended to the evidence directory so the parent can observe a held prompt. */
function record(event: Record<string, unknown>): void {
	events.push(event);
	const dir = process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE;
	if (!dir) return;
	fs.appendFileSync(path.join(dir, "runner-evidence.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
}

function controlledFactory(): ChildSessionFactory {
	const factory: ChildSessionFactory = {
		async create(launch) {
			record({ event: "create", agent: launch.runtime.agent, cwd: launch.cwd });
			for (const consumerId of config.claimOnly ?? []) claimChildAuthority(consumerId, launch.cwd);
			for (const consumerId of config.consumers ?? []) {
				claimChildAuthority(consumerId, launch.cwd);
				acknowledgeChildAuthority(consumerId);
			}
			const listeners = new Set<(event: Record<string, unknown>) => void>();
			return {
				subscribe(listener) {
					listeners.add(listener as (event: Record<string, unknown>) => void);
					return () => listeners.delete(listener as (event: Record<string, unknown>) => void);
				},
				async prompt(text: string) {
					record({ event: "prompt", text });
					if (!config.hangUntilAbort) return;
					await new Promise<void>((resolve) => waiters.push(resolve));
				},
				async steer() {},
				async followUp() {},
				async abort() {
					record({ event: "abort" });
					for (const release of waiters.splice(0)) release();
				},
				async dispose() {
					record({ event: "dispose" });
				},
				get messages() { return []; },
				sessionFile: undefined,
				sessionId: "launch-fixture-session",
				modelId: undefined,
			};
		},
		async dispose() {},
	};
	return factory;
}

function fixtureLaunch(): InProcessChildLaunch {
	const runtime = {
		agent: config.agent,
		childIndex: config.index,
		runId: config.runId,
		fanoutChild: false,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		waitTool: { enabled: false },
		fast: false,
	};
	return {
		toolPlan: { extensionArgs: [], requiredExtensions: [], configuredExtensions: [], runtimeExtensions: [], warnings: [] } as unknown as InProcessChildLaunch["toolPlan"],
		config: runtime as unknown as InProcessChildLaunch["config"],
		session: {
			cwd: config.cwd,
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime,
		} as unknown as InProcessChildLaunch["session"],
		capture: {
			structuredOutput: () => ({ called: false, acceptanceReportProvided: false }),
			toolDiagnostic: () => undefined,
			runtimeAcknowledgedExtensions: () => undefined,
			finalDrainHeld: () => false,
		},
		launchResolvedExtensions: { version: 1 } as unknown as InProcessChildLaunch["launchResolvedExtensions"],
		warnings: [],
	};
}

const result: Record<string, unknown> = { pid: process.pid, events };
try {
	const authority = await bindRunnerChildAuthority({ request: config.request });
	result.bound = authority !== undefined;
	result.leaseId = authority?.lease.leaseId;
	result.identity = authority?.lease.identity;
	result.requiredConsumers = authority?.lease.requiredConsumers;
	// Opaque payload evidence: the launcher transports bytes and never reads policy from them.
	result.payloadKeys = authority ? Object.keys(authority.lease.payload).sort() : undefined;
	if (authority && config.nested) {
		if (config.nested.disposeFirst) authority.dispose();
		// Real dispatch from a guarded runner: the latch refuses before any run directory or child exists.
		const { DIRS } = await import("../../../src/shared/types.ts");
		const { executeAsyncSingle } = await import("../../../src/runs/background/async-execution.ts");
		const { runSync } = await import("../../../src/runs/foreground/execution.ts");
		const nestedDir = path.join(DIRS.async, config.nested.runId);
		result.nestedDirBefore = fs.existsSync(nestedDir);
		const background = executeAsyncSingle(config.nested.runId, {
			agent: config.nested.backgroundAgent,
			task: "nested background child",
			agentConfig: { name: config.nested.backgroundAgent, description: "fixture", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: [], excludeTools: [] },
			ctx: { pi: { events: { emit() {} } }, cwd: config.cwd, currentSessionId: "nested-session" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});
		result.nestedBackground = background instanceof Promise
			? { pending: true }
			: { isError: background.isError === true, text: String(background.content[0]?.text ?? "") };
		result.nestedDirAfter = fs.existsSync(nestedDir);
		const foreground = await runSync(config.cwd, [{ name: config.nested.foregroundAgent, description: "fixture", systemPrompt: "", systemPromptMode: "replace", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: [], excludeTools: [] }], config.nested.foregroundAgent, "nested foreground child", {});
		result.nestedForeground = { exitCode: foreground.exitCode, error: foreground.error };
	}
	if (authority && !config.nested?.disposeFirst) {
		const run = await runChildSession({
			factory: controlledFactory(),
			launch: fixtureLaunch(),
			authority,
			prompt: config.prompt ?? "fixture task",
			appendChildEvent: () => {},
			writeOutputLine: () => {},
		});
		result.run = { exitCode: run.exitCode, error: run.error, interrupted: run.interrupted, stopped: run.stopped, timedOut: run.timedOut };
		authority.dispose();
	}
} catch (error) {
	result.error = { code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(`LAUNCH_RESULT ${JSON.stringify(result)}\n`, () => process.exit(0));
