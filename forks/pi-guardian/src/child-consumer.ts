import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildConsumerApi, ChildConsumerLease } from "../../pi-sbx/src/child-consumer-api.ts";
import { createAction, createActionWithParents, type ActiveToolAction } from "./tool-action.ts";
import { validateExactToolJson } from "./delegated-tool.ts";

type ConsumerBridge = typeof import("../../pi-sbx/src/child-consumer-api.ts");

/** Root/child lookup tripwire only; the actual role decision and claim come
 * from the co-installed launcher's SAME public API. Standalone root Guardian
 * must not require pi-sbx/pi-subagents merely to load its ordinary extension. */
export function mayBeDelegatedGuardian(): boolean {
	return Symbol.for("pi-subagents.child-authority-lease.v1") in globalThis ||
		Symbol.for("pi-subagents.child-authority-runner.v1") in globalThis;
}

/** Delegated Guardian is a semantic forwarder, never a second reviewer/broker,
 * root config loader, maintenance grant, denial cache or permission store. */
export async function registerChildGuardian(pi: ExtensionAPI, root: () => void, options: {
	loadBridge?: () => Promise<ConsumerBridge>;
} = {}): Promise<void> {
	let phase: "initializing" | "active" | "failed" | "closed" | "root" = "initializing";
	let failure = "delegated Guardian is not initialized";
	let lease: ChildConsumerLease | undefined;
	let api: ChildConsumerApi;
	let bridge: ConsumerBridge;
	let policy: ReturnType<ConsumerBridge["decodeChildPolicy"]>;
	let sessionId: string;
	const activeCalls = new Map<string, ActiveToolAction>();
	const poison = (reason: string): void => {
		failure = reason;
		phase = "failed";
		activeCalls.clear();
		lease?.dispose();
	};
	const blocked = (reason: string, terminate = true) => ({ block: true as const, reason: `Child Guardian blocked the action: ${reason}`, terminate });

	// Registered BEFORE an asynchronous public API lookup. A missing/failed API
	// must leave an actual blocking hook, not an SDK notification error that
	// could allow a later tool to execute. Only a proven inactive context is root.
	pi.on("tool_call", async (event, ctx) => {
		if (phase === "root") return;
		if (phase !== "active" || !lease) return blocked(failure);
		try {
			lease.assertReady();
			if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("the child SDK session identity changed");
			bridge.decodeChildPolicy(policy, ctx.cwd);
			if (ctx.signal?.aborted) throw new Error("the child action was cancelled");
			if (activeCalls.has(event.toolCallId) || activeCalls.size >= 256) throw new Error("delegated active tool evidence was replayed or exceeded its bounded lifetime capacity");
			// SDK tool_call input is otherwise mutable across async handlers. Lock
			// the actual execution reference, not just its review clone: later
			// code/handlers must not substitute arguments after parent admission.
			validateExactToolJson(event.input, { lock: true });
			Object.defineProperty(event, "input", { value: event.input, enumerable: true, writable: false, configurable: false });
			activeCalls.set(event.toolCallId, { action: createAction(event.toolName, event.toolCallId, event.input, ctx.cwd),
				parentToolCallId: event.parentToolCallId, sessionId });
			const { action } = createActionWithParents({ toolName: event.toolName, toolCallId: event.toolCallId,
				input: event.input, cwd: ctx.cwd, parentToolCallId: event.parentToolCallId,
				branch: ctx.sessionManager.getBranch(), activeCalls, sessionId });
			const verdict = await lease.request({ surface: "tool", target: JSON.stringify(action), reason: "Review this exact delegated tool action and complete nested parent evidence" },
				ctx.signal ? AbortSignal.any([lease.signal, ctx.signal]) : lease.signal);
			if (phase !== "active" || lease.signal.aborted || ctx.signal?.aborted) throw new Error("the parent authority or child action ended before verdict consumption");
			if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("the child SDK session changed during review");
			bridge.decodeChildPolicy(policy, ctx.cwd);
			if (verdict.outcome !== "allow") {
				const reason = verdict.rationale ?? `parent decision: ${verdict.outcome}`;
				// SDK batch termination can resolve prompt() normally with no terminal
				// assistant message. End the shared authority lifetime too, so the
				// standard runner observes cancellation rather than reporting success.
				if (verdict.terminate) poison(reason);
				return blocked(reason, verdict.terminate === true);
			}
			// Semantic allow grants NO file scope, log path or host command. The
			// separately installed pi-sbx adapters must still admit those actions.
			return;
		} catch (error) {
			poison(error instanceof Error ? error.message : "delegated review failed");
			return blocked(failure);
		}
	});

	try {
		const load = options.loadBridge ?? (async () => {
			// The source-mode installer mirrors src/, not package.json exports.
			// This documented co-installed subpath needs no manifest/dep overlay.
			const entry = "pi-sbx/src/child-consumer-api.ts";
			return await import(entry) as ConsumerBridge;
		});
		bridge = await load();
		api = await bridge.loadInstalledChildConsumerApi(getAgentDir());
		const child = api.hasChildAuthorityContext();
		if (typeof child !== "boolean") throw new Error("the public child-context detector returned no boolean role");
		if (!child) {
			phase = "root";
			root();
			return;
		}
		pi.on("tool_result", event => { activeCalls.delete(event.toolCallId); });
		pi.on("session_start", (_event, ctx) => {
			try {
				if (phase !== "initializing") throw new Error("delegated Guardian cannot initialize or rebind a second SDK session");
				lease = api.claimChildAuthority("pi-guardian", ctx.cwd);
				if (lease.version !== api.CHILD_AUTHORITY_PROVIDER_VERSION || !["pi-sbx", "pi-guardian"].every(id => lease!.requiredConsumers.includes(id))) throw new Error("the live lease does not require both real enforcement consumers");
				if (lease.signal.aborted) throw new Error("parent authority ended before Guardian initialization");
				policy = bridge.decodeChildPolicy(lease.payload, ctx.cwd);
				sessionId = ctx.sessionManager.getSessionId();
				if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("the child SDK has no stable session identity");
				lease.signal.addEventListener("abort", () => {
					if (phase !== "closed") poison("parent authority was revoked or its transport ended");
				}, { once: true });
				phase = "active";
				// Only these actual installed handlers/lifecycle are acknowledged;
				// the sandbox's separate acknowledgment is still mandatory.
				api.acknowledgeChildAuthority("pi-guardian");
			} catch (error) {
				poison(error instanceof Error ? error.message : "Guardian child initialization failed");
				throw error;
			}
		});
		pi.on("session_shutdown", () => {
			phase = "closed";
			failure = "the delegated Guardian session ended";
			activeCalls.clear();
			lease?.dispose();
		});
	} catch (error) {
		poison(error instanceof Error ? error.message : "the public child authority API could not load");
		throw error;
	}
}
