import assert from "node:assert/strict";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ChildAuthorityError,
	CHILD_AUTHORITY_PROVIDER_VERSION,
	createChildAuthorityController,
	readChildAuthorityProvider,
	type ChildAuthorityController,
	type ChildAuthorityIdentity,
	type ChildAuthorityPayload,
	type ChildAuthorityProvider,
	type ChildAuthorityProviderLease,
} from "../../src/api/child-authority.ts";
import { registerRequiredChildExtensions, type RequiredChildExtensionRegistration } from "../../src/api/required-child-extensions.ts";
import { CHILD_AUTHORITY_PROVIDER_KEY } from "../../src/runs/shared/child-authority.ts";
import {
	admitChildAuthorityLaunch,
	childAuthorityForegroundRefusal,
	childAuthorityPlacementRefusal,
	childAuthorityRunnerRequest,
	launcherDisplayName,
	nestedChildAuthorityRefusal,
} from "../../src/runs/shared/child-authority-launch.ts";
import { executeAsyncChain, executeAsyncSingle, isAsyncAvailable } from "../../src/runs/background/async-execution.ts";
import { childSessionFactoryModule, setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { DIRS } from "../../src/shared/types.ts";
import { createEventBus, createTempDir, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(projectRoot, "test/fixtures/child-authority");
const RUNNER_FIXTURE = path.join(fixtureDir, "launch-runner.ts");
const CONSUMER_FACTORY = path.join(fixtureDir, "launch-consumer-factory.ts");
const INERT_EXTENSION = path.join(fixtureDir, "inert-extension.ts");
const RESULT_PREFIX = "LAUNCH_RESULT ";

const SESSION_ID = "session-launch-fixture";
const RUN_ID = "run-launch-fixture";
const CWD = "/workspace/launch-fixture";
const CONSUMERS = ["pi-sbx", "guardian"];
const PAYLOAD: ChildAuthorityPayload = { version: 1, marker: "opaque-policy-bytes" };

function providerFor(sessionId: string, options: { consumers?: readonly string[]; payload?: ChildAuthorityPayload; dispose?: () => void } = {}): ChildAuthorityProvider {
	return {
		version: CHILD_AUTHORITY_PROVIDER_VERSION,
		sessionId,
		requiredExtensions: [
			{ id: "pi-sbx", path: CONSUMER_FACTORY },
			{ id: "guardian", path: INERT_EXTENSION },
		],
		async prepare(): Promise<ChildAuthorityProviderLease> {
			return {
				payload: options.payload ?? PAYLOAD,
				requiredConsumers: [...(options.consumers ?? CONSUMERS)],
				async decide() {
					return { outcome: "deny" as const, rationale: "launch fixture denies every action" };
				},
				dispose: () => options.dispose?.(),
			};
		},
	};
}

function publishProvider(provider: unknown): void {
	(globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY] = provider;
}

function clearProvider(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[CHILD_AUTHORITY_PROVIDER_KEY];
}

function requireCode(code: string) {
	return (error: unknown): boolean => {
		assert.ok(error instanceof ChildAuthorityError, `expected a ChildAuthorityError, got ${String(error)}`);
		assert.equal(error.code, code);
		return true;
	};
}

describe("child authority launch admission", () => {
	let registrations: RequiredChildExtensionRegistration[] = [];
	const register = (sessionId: string): void => {
		registrations.push(registerRequiredChildExtensions({
			sessionId,
			extensions: [
				{ id: "pi-sbx", path: CONSUMER_FACTORY },
				{ id: "guardian", path: INERT_EXTENSION },
			],
			requireForAllRunners: true,
		}));
	};

	beforeEach(() => {
		clearProvider();
	});

	afterEach(() => {
		for (const registration of registrations.splice(0)) registration.dispose();
		clearProvider();
	});

	it("keeps an unguarded session's launches alone when nothing demands child authority", () => {
		assert.deepEqual(admitChildAuthorityLaunch({ hostSessionId: SESSION_ID }), { guarded: false });
		assert.equal(childAuthorityRunnerRequest({ guarded: false }), undefined);
	});

	it("refuses a launch whose host session identity cannot be resolved", () => {
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: undefined }), requireCode("invalid-identity"));
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: " padded " }), requireCode("invalid-identity"));
	});

	it("fails closed when the host session requires child authority but no provider is published", () => {
		register(SESSION_ID);
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: SESSION_ID }), requireCode("service-missing"));
	});

	it("treats a published provider as guarded even when nothing is registered", () => {
		publishProvider(providerFor(SESSION_ID));
		const admission = admitChildAuthorityLaunch({ hostSessionId: SESSION_ID });
		assert.equal(admission.guarded, true);
		assert.equal(admission.provider?.sessionId, SESSION_ID);
		assert.deepEqual(childAuthorityRunnerRequest(admission), { version: 1 });
	});

	it("treats an inherited mandatory snapshot as a tightening signal", () => {
		const snapshot = [{ id: "pi-sbx", path: CONSUMER_FACTORY, requireForAllRunners: true as const }];
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: SESSION_ID, tighteningSnapshots: [snapshot] }), requireCode("service-missing"));
		assert.deepEqual(admitChildAuthorityLaunch({ hostSessionId: SESSION_ID, tighteningSnapshots: [[{ id: "pi-sbx", path: CONSUMER_FACTORY }]] }), { guarded: false });
	});

	it("refuses a malformed, unsupported or foreign-session provider instead of reading it as absent", () => {
		publishProvider({ ...providerFor(SESSION_ID), version: 1 });
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: SESSION_ID }), requireCode("version-mismatch"));
		publishProvider(providerFor(SESSION_ID));
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: "session-other" }), requireCode("session-mismatch"));
		publishProvider("not-a-provider");
		assert.throws(() => admitChildAuthorityLaunch({ hostSessionId: SESSION_ID }), requireCode("service-malformed"));
		assert.throws(() => readChildAuthorityProvider(SESSION_ID), requireCode("service-malformed"));
	});

});

describe("child authority placement", () => {
	const supported = { host: "runner" as const, children: 1 };

	it("admits exactly one native background child", () => {
		assert.equal(childAuthorityPlacementRefusal(supported), undefined);
	});

	it("names the reason for every unsupported placement", () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ host: "parent", children: 1 }, /foreground/],
			[{ host: "runner", children: 2 }, /2 child sessions/],
			[{ ...supported, chain: true }, /chain/],
			[{ ...supported, parallel: true }, /parallel/],
			[{ ...supported, dynamic: true }, /dynamic/],
			[{ ...supported, nested: true }, /nested/],
			[{ ...supported, externalRunner: "external-cli" }, /external-cli/],
			[{ ...supported, machine: "saved-box" }, /saved-box/],
			[{ ...supported, launcher: "broker" }, /broker/],
			[{ ...supported, binaryHost: true }, /binary host/],
			[{ ...supported, retainedResume: true }, /retained/],
			[{ ...supported, managedWorktree: true }, /worktree/],
			[{ ...supported, scheduled: true }, /schedule/],
		];
		for (const [placement, expected] of cases) {
			const refusal = childAuthorityPlacementRefusal(placement as never);
			assert.ok(refusal, `expected a refusal for ${JSON.stringify(placement)}`);
			assert.match(refusal, expected);
		}
	});

	it("reads a launcher wrapper from the object the runner config actually stores", () => {
		// The config stores `{name, argv}`; a producer that only forwarded strings left the refusal dead.
		assert.equal(launcherDisplayName({ name: "broker", argv: ["/bin/true"] }), "broker");
		assert.equal(launcherDisplayName("broker"), "broker");
		assert.equal(launcherDisplayName({ argv: ["/bin/true"] }), "launcher");
		assert.equal(launcherDisplayName(undefined), undefined);
	});

	it("refuses an in-parent child under child authority and leaves an unguarded session alone", () => {
		assert.equal(childAuthorityForegroundRefusal({ hostSessionId: SESSION_ID }), undefined);
		publishProvider(providerFor(SESSION_ID));
		try {
			const refusal = childAuthorityForegroundRefusal({ hostSessionId: SESSION_ID });
			assert.ok(refusal);
			assert.match(refusal, /foreground/);
			assert.match(refusal, /async: true/);
		} finally {
			clearProvider();
		}
	});
});

interface RunnerFixtureOutcome {
	result: Record<string, unknown>;
	code: number | null;
	stderr: string;
}

interface RunnerFixtureHandle {
	child: ChildProcess;
	outcome: Promise<RunnerFixtureOutcome>;
}

function startRunnerFixture(config: Record<string, unknown>, options: { attachChannel?: boolean } = {}): RunnerFixtureHandle {
	const attachChannel = options.attachChannel !== false;
	const child = spawn(process.execPath, ["--experimental-strip-types", RUNNER_FIXTURE, JSON.stringify(config)], {
		cwd: projectRoot,
		stdio: attachChannel ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let result: Record<string, unknown> | undefined;
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
		let newline = stdout.indexOf("\n");
		while (newline >= 0) {
			const line = stdout.slice(0, newline);
			stdout = stdout.slice(newline + 1);
			if (line.startsWith(RESULT_PREFIX)) result = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
			newline = stdout.indexOf("\n");
		}
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
	const outcome = new Promise<RunnerFixtureOutcome>((resolve) => {
		let settled = false;
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ result: result ?? {}, code, stderr });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, 30_000);
		timer.unref();
		child.on("exit", (code) => finish(code));
		child.on("error", () => finish(null));
	});
	return { child, outcome };
}

function fixtureEvents(result: Record<string, unknown>): string[] {
	return ((result.events as Array<{ event?: string }> | undefined) ?? []).map((entry) => String(entry.event));
}

function fixtureConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { runId: RUN_ID, agent: "worker", index: 0, cwd: CWD, request: { version: 1 }, ...overrides };
}

function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = (): void => {
			if (check()) {
				resolve();
				return;
			}
			if (Date.now() - started > timeoutMs) {
				reject(new Error(`timed out waiting for ${label}`));
				return;
			}
			setTimeout(poll, 5);
		};
		poll();
	});
}

describe("child authority over the real runner IPC channel", () => {
	let controllers: ChildAuthorityController[] = [];
	let evidenceRoot: string | undefined;

	/** A per-test directory the fixture appends its steps to, so a held prompt is observable. */
	function withEvidenceDir(): void {
		evidenceRoot = createTempDir("authority-launch-evidence-");
		process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE = evidenceRoot;
	}

	afterEach(() => {
		for (const controller of controllers.splice(0)) controller.dispose();
		clearProvider();
		delete process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE;
		if (evidenceRoot) removeTempDir(evidenceRoot);
		evidenceRoot = undefined;
	});

	async function prepare(fixture: RunnerFixtureHandle, options: { identity?: Partial<{ agent: string; index: number; cwd: string }>; consumers?: readonly string[] } = {}): Promise<void> {
		const controller = createChildAuthorityController({
			child: fixture.child,
			provider: readChildAuthorityProvider(SESSION_ID),
			sessionId: SESSION_ID,
			runId: RUN_ID,
		});
		controllers.push(controller);
		await controller.prepare({ agent: "worker", index: 0, cwd: CWD, ...options.identity });
	}

	it("loads the child only after every required consumer acknowledged, then prompts", async () => {
		publishProvider(providerFor(SESSION_ID));
		const fixture = startRunnerFixture(fixtureConfig({ consumers: CONSUMERS }));
		await prepare(fixture);
		const { result } = await fixture.outcome;
		assert.deepEqual(result.error, undefined);
		assert.equal(result.bound, true);
		assert.deepEqual(result.requiredConsumers, CONSUMERS);
		// The payload stays opaque: the launcher only carries its keys, never interprets them.
		assert.deepEqual(result.payloadKeys, ["marker", "version"]);
		assert.equal(result.identity && (result.identity as ChildAuthorityIdentity).cwd, CWD);
		assert.deepEqual(fixtureEvents(result), ["create", "prompt", "dispose"]);
		assert.equal((result.run as { exitCode?: number }).exitCode, 0);
	});

	it("never reaches a first prompt while a required consumer has not acknowledged", async () => {
		publishProvider(providerFor(SESSION_ID));
		const fixture = startRunnerFixture(fixtureConfig({ claimOnly: ["pi-sbx"] }));
		await prepare(fixture);
		const { result } = await fixture.outcome;
		assert.deepEqual(fixtureEvents(result), ["create", "dispose"]);
		assert.equal((result.run as { exitCode?: number }).exitCode, 1);
		assert.match(String((result.run as { error?: string }).error), /guardian/);
	});

	it("refuses to load a child the prepared lease did not name", async () => {
		publishProvider(providerFor(SESSION_ID));
		const fixture = startRunnerFixture(fixtureConfig({ consumers: CONSUMERS, cwd: `${CWD}-moved` }));
		await prepare(fixture);
		const { result } = await fixture.outcome;
		assert.deepEqual(fixtureEvents(result), []);
		assert.match(String((result.run as { error?: string }).error), /refusing to load a child the host did not admit/);
		assert.equal((result.run as { exitCode?: number }).exitCode, 1);
	});

	it("refuses a writable config that demands authority from a process with no host channel", async () => {
		const fixture = startRunnerFixture(fixtureConfig(), { attachChannel: false });
		const { result } = await fixture.outcome;
		assert.deepEqual(fixtureEvents(result), []);
		assert.equal((result.error as { code?: string }).code, "transport-unavailable");
	});

	it("keeps a channel-less runner without an authority marker unguarded", async () => {
		const fixture = startRunnerFixture({ runId: RUN_ID, agent: "worker", index: 0, cwd: CWD }, { attachChannel: false });
		const { result } = await fixture.outcome;
		assert.equal(result.bound, false);
		assert.deepEqual(result.error, undefined);
		assert.deepEqual(fixtureEvents(result), []);
	});

	it("aborts the running session when the parent loses the channel", async () => {
		publishProvider(providerFor(SESSION_ID));
		withEvidenceDir();
		const fixture = startRunnerFixture(fixtureConfig({ consumers: CONSUMERS, hangUntilAbort: true }));
		await prepare(fixture);
		await waitFor(() => runnerEvidence().includes("prompt"), "the fixture prompt", 15_000);
		fixture.child.disconnect();
		const { result } = await fixture.outcome;
		assert.deepEqual(fixtureEvents(result), ["create", "prompt", "abort", "dispose"]);
		assert.match(String((result.run as { error?: string }).error), /revoked child authority/);
	});

	it("refuses real nested foreground and background dispatch from the guarded runner itself", async () => {
		publishProvider(providerFor(SESSION_ID));
		const nestedRunId = `nested-from-guarded-runner-${Date.now().toString(36)}`;
		const fixture = startRunnerFixture(fixtureConfig({
			consumers: CONSUMERS,
			nested: { runId: nestedRunId, foregroundAgent: "nested-worker", backgroundAgent: "nested-worker" },
		}));
		await prepare(fixture);
		const { result } = await fixture.outcome;
		assert.deepEqual(result.error, undefined);
		// The admitted child still ran correctly around the refused nested attempts.
		assert.deepEqual(fixtureEvents(result), ["create", "prompt", "dispose"]);
		const background = result.nestedBackground as { isError?: boolean; text?: string; pending?: boolean } | undefined;
		assert.equal(background?.pending, undefined, "a nested background launch must be refused synchronously");
		assert.equal(background?.isError, true);
		assert.match(String(background?.text), /guarded child authority runner/);
		assert.match(String(background?.text), /nested background/);
		const foreground = result.nestedForeground as { exitCode?: number; error?: string } | undefined;
		assert.equal(foreground?.exitCode, 1);
		assert.match(String(foreground?.error), /nested foreground/);
		// Refusal precedes mutation: no nested run directory was created at any point.
		assert.equal(result.nestedDirBefore, false);
		assert.equal(result.nestedDirAfter, false);
	});

	it("still refuses real nested dispatch after the runner disposes its authority", async () => {
		publishProvider(providerFor(SESSION_ID));
		const fixture = startRunnerFixture(fixtureConfig({
			nested: { runId: `nested-disposed-${Date.now()}`, foregroundAgent: "fg", backgroundAgent: "bg", disposeFirst: true },
		}));
		await prepare(fixture);
		const { result } = await fixture.outcome;
		assert.deepEqual(result.error, undefined);
		assert.equal((result.nestedBackground as { isError?: boolean }).isError, true);
		assert.match(String((result.nestedForeground as { error?: string }).error), /nested foreground/);
		assert.equal(result.nestedDirBefore, false);
		assert.equal(result.nestedDirAfter, false);
		assert.deepEqual(fixtureEvents(result), []);
	});

	it("aborts the running session when the parent disposes the lease", async () => {
		publishProvider(providerFor(SESSION_ID));
		withEvidenceDir();
		const fixture = startRunnerFixture(fixtureConfig({ consumers: CONSUMERS, hangUntilAbort: true }));
		await prepare(fixture);
		await waitFor(() => runnerEvidence().includes("prompt"), "the fixture prompt", 15_000);
		for (const controller of controllers.splice(0)) controller.dispose();
		const { result } = await fixture.outcome;
		assert.deepEqual(fixtureEvents(result), ["create", "prompt", "abort", "dispose"]);
	});
});

/** Evidence the fixtures stream while they run, so a held prompt is observable before the parent acts. */
function evidenceLines(fileName: string): Array<Record<string, unknown>> {
	const dir = process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE;
	if (!dir) return [];
	try {
		return fs.readFileSync(path.join(dir, fileName), "utf-8").trim().split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function runnerEvidence(): string[] {
	return evidenceLines("runner-evidence.jsonl").map((entry) => String(entry.event));
}

function runnerEvidencePid(): number | undefined {
	const pids = evidenceLines("launch-evidence.jsonl").map((entry) => entry.pid).filter((pid): pid is number => typeof pid === "number");
	return pids[0];
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

describe("registered async dispatch under child authority", { skip: isAsyncAvailable() ? undefined : "native async runner unavailable" }, () => {
	let tempDir: string;
	let registration: RequiredChildExtensionRegistration | undefined;
	let originalFactoryModule: string | undefined;

	let dispatchEvidenceRoot: string | undefined;

	/** The dispatch negatives reuse the same streamed-evidence mechanism as the IPC fixtures. */
	function withEvidenceDir(): void {
		dispatchEvidenceRoot = createTempDir("authority-launch-evidence-");
		process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE = dispatchEvidenceRoot;
	}

	beforeEach(() => {
		tempDir = createTempDir("authority-launch-");
		originalFactoryModule = childSessionFactoryModule();
	});

	afterEach(() => {
		registration?.dispose();
		registration = undefined;
		setChildSessionFactoryModule(originalFactoryModule);
		clearProvider();
		delete process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE;
		if (dispatchEvidenceRoot) removeTempDir(dispatchEvidenceRoot);
		dispatchEvidenceRoot = undefined;
		removeTempDir(tempDir);
	});

	function launch(id: string, overrides: { agentConfig?: ReturnType<typeof makeAgent>; ctx?: Record<string, unknown> } = {}) {
		return executeAsyncSingle(id, {
			agent: "worker",
			task: "Do the admitted work",
			agentConfig: overrides.agentConfig ?? makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: SESSION_ID, ...overrides.ctx },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});
	}

	function registerHostGuard(): void {
		registration = registerRequiredChildExtensions({
			sessionId: SESSION_ID,
			extensions: [{ id: "pi-sbx", path: CONSUMER_FACTORY }, { id: "guardian", path: INERT_EXTENSION }],
			requireForAllRunners: true,
		});
	}

	it("refuses the launch before the runner starts when the host requires authority but no provider is published", () => {
		registration = registerRequiredChildExtensions({
			sessionId: SESSION_ID,
			extensions: [{ id: "pi-sbx", path: CONSUMER_FACTORY }, { id: "guardian", path: INERT_EXTENSION }],
			requireForAllRunners: true,
		});
		const id = `authority-missing-${Date.now().toString(36)}`;
		const result = launch(id);
		assert.ok(!(result instanceof Promise), "a refused launch returns without spawning");
		assert.equal(result.isError, true);
		assert.match(String(result.content[0]?.text), /no child authority service is published/i);
	});

	it("admits one guarded background child and prompts only after the consumers acknowledge", async () => {
		registration = registerRequiredChildExtensions({
			sessionId: SESSION_ID,
			extensions: [{ id: "pi-sbx", path: CONSUMER_FACTORY }, { id: "guardian", path: INERT_EXTENSION }],
			requireForAllRunners: true,
		});
		publishProvider(providerFor(SESSION_ID));
		setChildSessionFactoryModule(CONSUMER_FACTORY);
		const evidenceDir = path.join(tempDir, "evidence");
		fs.mkdirSync(evidenceDir, { recursive: true });
		process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE = evidenceDir;
		const id = `authority-admitted-${Date.now().toString(36)}`;
		try {
			const launchResult = await launch(id);
			assert.equal(launchResult.isError, undefined, String(launchResult.content[0]?.text));
			const evidencePath = path.join(evidenceDir, "launch-evidence.jsonl");
			await waitFor(() => fs.existsSync(evidencePath) && fs.readFileSync(evidencePath, "utf-8").includes("\"prompt\""), "the admitted child prompt", 20_000);
			const events = fs.readFileSync(evidencePath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; agent?: string; cwd?: string });
			assert.deepEqual(events.map(({ event }) => event).slice(0, 2), ["create", "prompt"]);
			assert.equal(events[0]?.agent, "worker");
			assert.equal(events[0]?.cwd, tempDir);
			assert.equal(events.some(({ event }) => event === "abort"), false);
		} finally {
			delete process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE;
		}
	});

	it("admits actual executor requests for explicit async, agent defaultAsync, and runner.type pi", async () => {
		registerHostGuard();
		publishProvider(providerFor(SESSION_ID));
		setChildSessionFactoryModule(CONSUMER_FACTORY);
		withEvidenceDir();
		for (const variant of ["explicit", "defaultAsync", "pi"] as const) {
			const agent = makeAgent("worker", variant === "defaultAsync" ? { defaultAsync: true } : variant === "pi" ? { runner: { type: "pi" } } : {});
			const executor = createSubagentExecutor({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [agent] }),
			} as unknown as Parameters<typeof createSubagentExecutor>[0]);
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionId = () => SESSION_ID;
			const result = await executor.execute(`authority-executor-${variant}`, {
				agent: "worker", task: variant, ...(variant === "defaultAsync" ? {} : { async: true }),
			}, new AbortController().signal, undefined, ctx as never);
			assert.notEqual(result.isError, true, JSON.stringify(result));
			await waitFor(() => evidenceLines("launch-evidence.jsonl").filter((entry) => entry.event === "prompt").length >= ["explicit", "defaultAsync", "pi"].indexOf(variant) + 1, `${variant} executor child prompt`, 20_000);
		}
	});

	it("refuses guarded workflow, schedule, foreground, fanout and append requests before discovery or evaluation", async () => {
		publishProvider(providerFor(SESSION_ID));
		let discovered = 0;
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
			discoverAgents: () => { discovered++; return { agents: [makeAgent("worker")] }; },
		} as unknown as Parameters<typeof createSubagentExecutor>[0]);
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => SESSION_ID;
		const marker = path.join(tempDir, "must-not-run");
		const requests = [
			[{ workflowScript: `throw new Error(${JSON.stringify(marker)})`, async: true }, /a workflow runs script/],
			[{ agent: "worker", task: "scheduled", async: true, scheduleOrigin: { id: "test" } }, /schedule/],
			[{ agent: "worker", task: "foreground", async: false }, /foreground/],
			[{ tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }], async: true }, /parallel/],
			[{ action: "append-step", id: "old-bare-run", step: { agent: "worker", task: "append" } }, /retained/],
			[{ action: "schedule.create", id: "not-created" }, /schedule/],
		] as const;
		for (const [request, expected] of requests) {
			const result = await executor.execute("guarded-entry", request as never, new AbortController().signal, undefined, ctx as never);
			assert.equal(result.isError, true, JSON.stringify(request));
			assert.match(JSON.stringify(result), expected);
		}
		assert.equal(discovered, 0);
		assert.equal(fs.existsSync(marker), false);
	});

	it("refuses a configured launcher wrapper before the wrapper or a run directory exists", () => {
		registerHostGuard();
		publishProvider(providerFor(SESSION_ID));
		const marker = path.join(tempDir, "wrapper-side-effect");
		const id = `authority-launcher-${Date.now().toString(36)}`;
		const result = launch(id, {
			agentConfig: makeAgent("worker", { launcher: "broker" }),
			ctx: { runnerLaunchers: { broker: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] } },
		});
		assert.ok(!(result instanceof Promise), "a refused wrapper launch returns without spawning");
		assert.equal(result.isError, true);
		assert.match(String(result.content[0]?.text), /launcher 'broker'/);
		assert.equal(fs.existsSync(marker), false, "the wrapper must never run");
		assert.equal(fs.existsSync(path.join(DIRS.async, id)), false);
	});

	it("refuses every unsupported placement before its run directory exists", async () => {
		registerHostGuard();
		publishProvider(providerFor(SESSION_ID));
		const singleId = `authority-single-placement-${Date.now().toString(36)}`;
		const singleResult = launch(singleId, { agentConfig: makeAgent("worker", { machine: "saved-box" }) });
		assert.ok(!(singleResult instanceof Promise));
		assert.equal(singleResult.isError, true);
		assert.match(String(singleResult.content[0]?.text), /machine 'saved-box'/);
		assert.equal(fs.existsSync(path.join(DIRS.async, singleId)), false);

		const chainId = `authority-chain-placement-${Date.now().toString(36)}`;
		const chainResult = await executeAsyncChain(chainId, {
			chain: [{ agent: "first", task: "A" }, { agent: "second", task: "B" }],
			agents: [makeAgent("first"), makeAgent("second")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: SESSION_ID },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		assert.equal(chainResult.isError, true);
		assert.equal(fs.existsSync(path.join(DIRS.async, chainId)), false);
	});

	it("refuses a malformed or foreign-session provider before the runner starts", () => {
		registerHostGuard();
		const cases: Array<[unknown, RegExp]> = [
			[{ ...providerFor(SESSION_ID), version: 1 }, /version 1 is unsupported/],
			[providerFor("session-other"), /belongs to session 'session-other'/],
		];
		for (const [provider, expected] of cases) {
			publishProvider(provider);
			const id = `authority-provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
			const result = launch(id);
			assert.ok(!(result instanceof Promise), `expected a synchronous refusal for ${String(expected)}`);
			assert.equal(result.isError, true);
			assert.match(String(result.content[0]?.text), expected);
			assert.equal(fs.existsSync(path.join(DIRS.async, id)), false);
		}
		clearProvider();
	});

	it("does not execute inherited Node preloads before the child authority binding", async () => {
		registerHostGuard();
		publishProvider({ ...providerFor(SESSION_ID), async prepare() { await new Promise(resolve => setTimeout(resolve, 600)); throw new Error("deliberate prepare refusal"); } });
		const marker = path.join(tempDir, "preload-ran"), preload = path.join(tempDir, "preload.mjs");
		fs.writeFileSync(preload, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran before binding');`);
		const previous = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
		try {
			const id = `authority-preload-${Date.now().toString(36)}`;
			const result = await launch(id);
			assert.equal(result.isError, true);
			const statusPath = path.join(DIRS.async, id, "status.json");
			if (fs.existsSync(statusPath) && JSON.parse(fs.readFileSync(statusPath, "utf8")).pid) {
				await waitFor(() => JSON.parse(fs.readFileSync(statusPath, "utf8")).processTerminal?.state === "observed", "the refused preload runner to terminate");
			}
			assert.equal(fs.existsSync(marker), false, "Node executed ambient preload code before the authority binding");
			assert.match(JSON.stringify(result), /inherited startup override.*NODE_OPTIONS/);
		} finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
	});

	for (const name of ["NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "OPENSSL_CONF", "OPENSSL_MODULES", "JITI_FS_CACHE"]) {
		it(`refuses inherited ${name} before any child spawn`, (t) => {
			registerHostGuard(); publishProvider(providerFor(SESSION_ID));
			const previous = process.env[name];
			const captured = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected child spawn"); }); syncBuiltinESMExports();
			process.env[name] = "untrusted-startup-override";
			try {
				const result = launch(`authority-bootstrap-${name}-${Date.now().toString(36)}`);
				assert.ok(!(result instanceof Promise)); assert.equal(result.isError, true);
				assert.match(JSON.stringify(result), new RegExp(`inherited startup override.*${name}`)); assert.equal(captured.mock.callCount(), 0);
			} finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
		});
	}

	it("preserves unguarded startup configuration instead of silently sanitizing it", (t) => {
		const previous = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = "--max-old-space-size=256";
		const captured = t.mock.method(childProcess, "spawn", () => { throw new Error("captured unguarded spawn"); }); syncBuiltinESMExports();
		try {
			const result = launch(`unguarded-bootstrap-${Date.now().toString(36)}`);
			assert.ok(!(result instanceof Promise)); assert.match(JSON.stringify(result), /captured unguarded spawn/);
			assert.equal(captured.mock.callCount(), 1); assert.equal(captured.mock.calls[0]!.arguments[2]!.env.NODE_OPTIONS, process.env.NODE_OPTIONS);
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
	});
	it("retains empty overrides and the existing host-owned peer alias replacement", (t) => {
		registerHostGuard(); publishProvider(providerFor(SESSION_ID));
		const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, JITI_ALIAS: process.env.JITI_ALIAS };
		process.env.NODE_OPTIONS = ""; process.env.JITI_ALIAS = '{"ambient":"untrusted"}';
		const captured = t.mock.method(childProcess, "spawn", () => { throw new Error("captured clean guarded spawn"); }); syncBuiltinESMExports();
		try {
			const result = launch(`guarded-owned-alias-${Date.now().toString(36)}`);
			assert.ok(!(result instanceof Promise)); assert.match(JSON.stringify(result), /captured clean guarded spawn/);
			assert.equal(captured.mock.callCount(), 1);
			const env = captured.mock.calls[0]!.arguments[2]!.env;
			assert.equal(env.NODE_OPTIONS, ""); assert.equal(JSON.parse(env.JITI_ALIAS).ambient, undefined);
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports();
			for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		}
	});

	it("refuses a launch whose provider cannot prepare, and leaves no running runner behind", async () => {
		registerHostGuard();
		publishProvider({ ...providerFor(SESSION_ID), async prepare() { throw new Error("provider initialization failed"); } });
		const id = `authority-prepare-failure-${Date.now().toString(36)}`;
		const result = await launch(id);
		assert.equal(result.isError, true);
		assert.match(String(result.content[0]?.text), /provider initialization failed/);
		// The failure is recorded as a pre-proceed startup failure, and the runner never reported running work.
		const status = JSON.parse(fs.readFileSync(path.join(DIRS.async, id, "status.json"), "utf-8")) as { state?: string; processTerminal?: { state?: string } };
		assert.equal(status.state, "failed");
		await waitFor(() => {
			const terminal = JSON.parse(fs.readFileSync(path.join(DIRS.async, id, "status.json"), "utf-8"));
			return terminal.processTerminal?.state === "observed";
		}, "the prepare-failed runner's observed process exit");
	});

	it("fails the admitted run before the first prompt when a consumer never acknowledges, and cleans the runner up", async () => {
		registerHostGuard();
		publishProvider(providerFor(SESSION_ID));
		setChildSessionFactoryModule(CONSUMER_FACTORY);
		withEvidenceDir();
		process.env.CHILD_AUTHORITY_LAUNCH_SKIP_ACK = "guardian";
		const id = `authority-unacknowledged-${Date.now().toString(36)}`;
		try {
			const launchResult = await launch(id);
			assert.equal(launchResult.isError, undefined, String(launchResult.content[0]?.text));
			const events = () => evidenceLines("launch-evidence.jsonl").map((entry) => String(entry.event));
			await waitFor(() => events().includes("create"), "the admitted child create", 20_000);
			// No first prompt may follow an unacknowledged lease, however long we watch.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			assert.equal(events().includes("prompt"), false);
			const pid = runnerEvidencePid();
			assert.ok(pid, "the evidence must name the runner process");
			await waitFor(() => !processAlive(pid!), "the guarded runner process to exit", 20_000);
			const status = JSON.parse(fs.readFileSync(path.join(DIRS.async, id, "status.json"), "utf-8")) as { state?: string; error?: string };
			assert.equal(status.state, "failed");
			assert.match(String(status.error), /guardian/);
		} finally {
			delete process.env.CHILD_AUTHORITY_LAUNCH_SKIP_ACK;
		}
	});

	it("refuses a chain under child authority without starting a runner", async () => {
		registration = registerRequiredChildExtensions({
			sessionId: SESSION_ID,
			extensions: [{ id: "pi-sbx", path: CONSUMER_FACTORY }],
			requireForAllRunners: true,
		});
		publishProvider(providerFor(SESSION_ID, { consumers: ["pi-sbx"] }));
		const id = `authority-chain-${Date.now().toString(36)}`;
		const result = await executeAsyncChain(id, {
			chain: [{ agent: "first", task: "A" }, { agent: "second", task: "B" }],
			agents: [makeAgent("first"), makeAgent("second")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: SESSION_ID },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		assert.equal(result.isError, true);
		assert.match(String(result.content[0]?.text), /chain/);
		assert.match(String(result.content[0]?.text), /exactly one native background child/);
	});
});
