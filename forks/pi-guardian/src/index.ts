import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { failedClosedAssessment, ruleDeniedAssessment } from "./assessment.ts";
import { assistantToolCalls, createAction, createActionWithParents, findAssistantCursor } from "./tool-action.ts";
import { mayBeDelegatedGuardian, registerChildGuardian } from "./child-consumer.ts";
import { loadGuardianConfig, persistGuardianEnabled } from "./config.ts";
import { evaluatePermissions, type PermissionDecision } from "./permissions.ts";
import { parseDelegatedToolRequest, type DelegatedToolDecision, type DelegatedToolRequest } from "./delegated-tool.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { requestGuardianAssessment } from "./sidecar.ts";
import { createSandboxBroker, publishSandboxBroker } from "./sandbox/broker.ts";
import {
	isProjectPolicyTrusted,
	persistProjectRule,
	projectPolicyPath,
	projectPolicySnapshot,
	readProjectPolicy,
	recordProjectTrust,
} from "./project-policy.ts";
import type { SandboxExceptionRules } from "./sandbox/types.ts";
import { buildSandboxExceptionPrompt, sandboxOutcomeFromAssessment } from "./sandbox/review.ts";
import { SANDBOX_EXCEPTION_ENTRY, type SandboxExceptionRequest } from "./sandbox/types.ts";
import {
	createGuardianState,
	findGuardianState,
	hashAction,
	hashText,
	stateMatchesConfig,
	updateDenialState,
} from "./state.ts";
import { latestUserTurnKey, renderGuardianTranscript } from "./transcript.ts";
import { registerGuardianAssessmentRenderer, setGuardianStatusWidget } from "./tui.ts";
import { GUARDIAN_USAGE_ENTRY, guardianUsageView, formatGuardianCosts, type GuardianUsageNotice } from "./usage.ts";
import {
	GUARDIAN_ASSESSMENT_ENTRY,
	GUARDIAN_STATE_ENTRY,
	GUARDIAN_STATUS_ENTRY,
	STATE_VERSION,
	type GuardianAction,
	type GuardianAssessment,
	type GuardianAssessmentRecordV1,
	type GuardianConfig,
	type GuardianParentAction,
	type GuardianStateV1,
	type RenderedTranscript,
} from "./types.ts";

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const POLICY_PATH = fileURLToPath(new URL("../prompts/guardian-policy.md", import.meta.url));

function conciseFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length <= 1_000 ? message : `${message.slice(0, 1_000)}…`;
}

export function guardianFailureHelp(failure: string, configPath: string): string {
	const normalized = failure.toLowerCase();
	if (normalized.includes("context") || normalized.includes("compact") || normalized.includes("directives")) {
		return `Guardian kept the action blocked. Check reviewer.context in ${configPath}; an oversized legacy reviewer may require human compaction of that exact session.`;
	}
	if (normalized.includes("locked")) return "Wait for the reviewer owner to exit; a human must investigate a stale reviewer lock. Do not delete it while a reviewer is running.";
	if (normalized.includes("timed out")) {
		return `Check reviewer connectivity or increase reviewer.timeoutMs in ${configPath}.`;
	}
	if (normalized.includes("could not start") || normalized.includes("enoent")) {
		return `Check piCommand in ${configPath} and make sure the Pi executable is available.`;
	}
	if (
		normalized.includes("auth") ||
		normalized.includes("credential") ||
		normalized.includes("unauthorized") ||
		normalized.includes("401")
	) {
		return `Authenticate the reviewer provider with Pi, then check reviewer.model in ${configPath}.`;
	}
	if (normalized.includes("model") || normalized.includes("provider")) {
		return `Check reviewer.model and its provider authentication in ${configPath}.`;
	}
	if (normalized.includes("malformed output") || normalized.includes("no assistant response")) {
		return `Check that reviewer.model in ${configPath} supports the configured policy and structured response.`;
	}
	return `Check reviewer.model, provider authentication, and piCommand in ${configPath}.`;
}

export function denialReason(assessment: GuardianAssessment, terminate: boolean, failed = false): string {
	const circuitBreaker = terminate
		? " Guardian rejected too many actions in this user turn, so this tool batch is being terminated."
		: "";
	return [
		failed
			? "Guardian could not complete the safety review, so the action was blocked."
			: "Guardian rejected this action due to unacceptable risk.",
		`Reason: ${assessment.rationale}${circuitBreaker}`,
		"Do not attempt to achieve the same outcome through a workaround, indirect execution, or policy circumvention. Choose a materially safer alternative or ask the user for explicit approval after explaining the concrete risk.",
	].join("\n");
}

function ruleDenialReason(rule: string, terminate: boolean): string {
	const circuitBreaker = terminate ? " Too many consecutive denials; this tool batch is being terminated." : "";
	return [
		`Guardian blocked this action by fixed permission rule ${rule}.${circuitBreaker}`,
		"Do not retry by other means, indirect execution, or a workaround.",
	].join("\n");
}

interface ReviewExecution {
	assessment: GuardianAssessment;
	failure?: string;
	validReview: boolean;
}

interface PendingReview {
	parentSessionId: string;
	state: GuardianStateV1;
	actionHash: string;
	evidenceKey?: string;
	configSnapshot?: GuardianConfig;
	promise: Promise<ReviewExecution>;
}

interface PreparedReview {
	actionHash: string;
	canBootstrap: boolean;
	launch: () => Promise<ReviewExecution>;
}

function fallbackActionHash(toolName: string, toolCallId: string, input: unknown): string {
	try {
		return hashAction({ tool_name: toolName, tool_call_id: toolCallId, input });
	} catch {
		return hashText(`${toolName}:${toolCallId}:unserializable`);
	}
}

async function assessAction(
	config: GuardianConfig,
	state: GuardianStateV1,
	parentSessionId: string,
	transcript: RenderedTranscript,
	action: GuardianAction,
	signal: AbortSignal | undefined,
	validate?: () => void,
	reportUsage?: (notice: GuardianUsageNotice) => void,
): Promise<ReviewExecution> {
	try {
		const serializedAction = JSON.stringify(action);
		if (serializedAction.length > config.maxActionChars) {
			throw new Error(`Planned action is too large to review safely (${serializedAction.length} characters)`);
		}
		return {
			assessment: await requestGuardianAssessment(
				config,
				state,
				buildReviewPrompt(parentSessionId, transcript, action, config.permissions.deny),
				signal,
				{ directives: [], evidence: [], ...transcript.reviewContext, action },
				validate,
				reportUsage,
			),
			validReview: true,
		};
	} catch (error) {
		const failure = conciseFailure(error);
		return { assessment: failedClosedAssessment(failure), failure, validReview: false };
	}
}

function branchWithPendingAssistant(
	branch: readonly SessionEntry[],
	message: unknown,
	toolCallIds: readonly string[],
): SessionEntry[] {
	const parentId = branch.at(-1)?.id ?? null;
	return [
		...branch,
		{
			type: "message",
			id: `guardian-preview-${hashText(toolCallIds.join(":"))}`,
			parentId,
			timestamp: new Date().toISOString(),
			message: message as never,
		},
	];
}

/** Canonical evidence key ignores only Guardian bookkeeping and this already-bound planned assistant call. */
export function reviewEvidenceKey(branch: readonly SessionEntry[], toolCallId?: string): string {
	return hashText(JSON.stringify(branch.flatMap<unknown>((entry) => {
		if (["usage", "label", "session_info", "thinking_level_change"].includes(entry.type)) return [];
		if (entry.type === "message") {
			if (toolCallId && assistantToolCalls(entry.message).some((call) => call.toolCallId === toolCallId)) return [];
			return [{ type: entry.type, id: entry.message.role === "user" ? entry.id : undefined, message: entry.message }];
		}
		if (entry.type === "custom") {
			const data = entry.data as { assessment?: { outcome?: string }; decision?: string } | undefined;
			if ((entry.customType === GUARDIAN_ASSESSMENT_ENTRY && data?.assessment?.outcome === "deny") ||
				(entry.customType === SANDBOX_EXCEPTION_ENTRY && (data?.decision === "deny" || data?.decision === "defer"))) return [entry];
			return [];
		}
		return [entry];
	})));
}

export default function guardianExtension(pi: ExtensionAPI) {
	if (mayBeDelegatedGuardian()) return registerChildGuardian(pi, () => rootGuardianExtension(pi));
	return rootGuardianExtension(pi);
}

function rootGuardianExtension(pi: ExtensionAPI) {
	registerGuardianAssessmentRenderer(pi);
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "guardian.json");
	let config: GuardianConfig | undefined;
	let policyHash: string | undefined;
	let initializationError: string | undefined;
	const activeCalls = new Map<string, { action: GuardianParentAction; parentToolCallId?: string; sessionId: string }>();
	let replayStatus = false;
	const appendStatus = () => pi.appendEntry(GUARDIAN_STATUS_ENTRY, {
		version: 1,
		guardianVersion: PACKAGE_VERSION,
		enabled: config?.enabled ?? true,
		reviewerModel: config?.reviewerModel ?? null,
		reviewerThinking: config?.thinkingLevel ?? null,
		policySha256: policyHash ?? null,
		exemptTools: config ? [...config.exemptTools] : [],
		permissions: config?.permissions ?? null,
		permissionsSha256: config ? hashText(JSON.stringify(config.permissions)) : null,
		configError: initializationError ?? null,
	});
	const pendingReviews = new Map<string, PendingReview>();
	let activeReviewCount = 0;
	let runningReviewCount = 0;
	const reviewSlotWaiters: Array<() => void> = [];

	try {
		config = loadGuardianConfig(agentDir, POLICY_PATH);
		policyHash = hashText(readFileSync(config.policyPath, "utf8"));
	} catch (error) {
		initializationError = conciseFailure(error);
	}

	let projectRules: SandboxExceptionRules | undefined;

	/** Standing rules from `<cwd>/.pi/guardian.json`, pinned to an approved hash. */
	/**
	 * Project-policy service for the sandbox layer: it persists a rule the user
	 * just approved (the "always allow" answer to an escalation) and records trust
	 * for the new content, so it applies immediately and in later sessions.
	 */
	const PROJECT_POLICY_KEY = Symbol.for("pi-guardian:project-policy");
	const publishProjectPolicy = (ctx: ExtensionContext): void => {
		const agentDir = config?.agentDir;
		if (!agentDir) return;
		const target = globalThis as Record<symbol, unknown>;
		let active = true;
		const service = {
			path: projectPolicyPath(ctx.cwd),
			// Capture before the human is asked, not after they answer. The closure
			// binds that approval to one rule and the exact trusted base bytes.
			prepareRule(rule: string) {
				const read = readProjectPolicy(ctx.cwd);
				const approved = projectPolicySnapshot(ctx.cwd, read);
				if (!active || !approved || (read.kind === "ok" &&
					!isProjectPolicyTrusted(agentDir, read.policy.path, read.policy.hash))) {
					return { ok: false as const, reason: "the current project policy is invalid or unapproved; review it before saving a standing rule" };
				}
				return {
					ok: true as const,
					commit() {
						if (!active) return { ok: false as const, reason: "the project-policy session has ended" };
						const result = persistProjectRule(ctx.cwd, rule, { agentDir, approved });
						if (!result.ok) return result;
						// Only trust/apply the returned bytes: never re-read a file another
						// process might have replaced after the approved write.
						recordProjectTrust(agentDir, result.path, result.hash);
						projectRules = result.sandboxExceptions;
						return result;
					},
				};
			},
		};
		target[PROJECT_POLICY_KEY] = service;
		disposeProjectPolicy = () => {
			active = false;
			if (target[PROJECT_POLICY_KEY] === service) delete target[PROJECT_POLICY_KEY];
		};
	};
	let disposeProjectPolicy: (() => void) | undefined;

	const resolveProjectPolicy = (ctx: ExtensionContext): void => {
		projectRules = undefined;
		const read = readProjectPolicy(ctx.cwd);
		if (read.kind === "none") return;
		if (read.kind === "invalid") {
			if (ctx.hasUI) ctx.ui.notify(`Ignored project Guardian policy (${read.path}): ${read.error}`, "error");
			return;
		}
		const { policy } = read;
		const agentDir = config?.agentDir;
		if (!agentDir) return;
		if (isProjectPolicyTrusted(agentDir, policy.path, policy.hash)) {
			projectRules = policy.sandboxExceptions;
			return;
		}
		// A subagent has no UI and must not self-approve workspace content.
		if (!ctx.hasUI) return;
		void (async () => {
			try {
				const approved = await ctx.ui.confirm(
					"Apply this project's Guardian policy?",
					`${policy.path} can pre-authorize sandbox exceptions for this project (for example git push or gh with the host's credentials). Approve only if you wrote or reviewed that file.`,
				);
				if (!approved) {
					ctx.ui.notify(`Ignored ${policy.path}; it stays inactive`, "warning");
					return;
				}
				recordProjectTrust(agentDir, policy.path, policy.hash);
				projectRules = policy.sandboxExceptions;
			} catch {
				// A prompt that cannot run leaves the project policy inactive.
			}
		})();
	};

	const costsFor = (ctx: ExtensionContext) => guardianUsageView(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId());
	const costText = (ctx: ExtensionContext) => formatGuardianCosts(costsFor(ctx));
	const usageReporter = (ctx: ExtensionContext) => (notice: GuardianUsageNotice): void => {
		const parentId = notice.kind === "snapshot" ? notice.snapshot.parentSessionId : notice.parentSessionId;
		// appendEntry targets the currently selected parent, not an old captured session.
		// The reviewer retains its own accounting for a later restore if this parent switched.
		if (ctx.sessionManager.getSessionId() !== parentId || latestCtx?.sessionManager.getSessionId() !== parentId) return;
		pi.appendEntry(GUARDIAN_USAGE_ENTRY, notice);
		if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, initializationError ? "error" : config?.enabled ? "enabled" : "disabled", config?.reviewerModel, costText(ctx));
	};

	pi.on("session_start", (_event, ctx) => {
		activeCalls.clear();
		disposeProjectPolicy?.();
		resolveProjectPolicy(ctx);
		publishProjectPolicy(ctx);
		appendStatus();
		// Pi 1.0 print mode subscribes after session_start. Replay once at input.
		replayStatus = ctx.mode === "json";
		latestCtx = ctx;
		// Published regardless of UI: headless sessions still escalate to the broker,
		// and the sandbox turns a missing broker into its own human prompt or deny.
		publishSandboxBrokerIfReady(ctx);
		if (!ctx.hasUI) return;
		if (config && !config.enabled) {
			if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, "disabled", config.reviewerModel, costText(ctx));
			ctx.ui.setStatus("pi-guardian", "guardian: disabled");
			return;
		}
		if (initializationError) {
			if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, "error", config?.reviewerModel, costText(ctx));
			ctx.ui.setStatus("pi-guardian", "guardian: configuration error");
			ctx.ui.notify(
				`Pi Guardian will fail closed: ${initializationError}\nFix: check ${configPath}, then restart Pi.`,
				"error",
			);
			return;
		}
		if (!config) return;
		if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, "enabled", config.reviewerModel, costText(ctx));
		ctx.ui.setStatus("pi-guardian", `guardian: ${config.reviewerModel}`);
	});

	pi.on("session_shutdown", () => {
		disposeSandboxBroker?.();
		disposeSandboxBroker = undefined;
		disposeProjectPolicy?.();
		disposeProjectPolicy = undefined;
		latestCtx = undefined;
	});

	pi.on("input", () => {
		if (replayStatus) {
			replayStatus = false;
			appendStatus();
		}
	});

	pi.on("tool_result", (event) => {
		activeCalls.delete(event.toolCallId);
	});

	pi.registerCommand("guardian", {
		description: "Toggle or inspect Pi Guardian (on, off, toggle, status, costs)",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "toggle", "status", "costs"];
			const matches = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase() || "toggle";
			if (requested === "costs") {
				const usage = costsFor(ctx);
				if (ctx.hasUI) ctx.ui.notify(formatGuardianCosts(usage, true), "info");
				else pi.appendEntry("pi-guardian.cost-report", { parentSessionId: ctx.sessionManager.getSessionId(), ...usage });
				return;
			}
			if (!config) {
				if (ctx.hasUI) ctx.ui.notify(`Guardian configuration cannot be changed: ${initializationError ?? "unknown error"}`, "error");
				return;
			}
			if (requested === "status") {
				if (initializationError) {
					if (ctx.hasUI) ctx.ui.notify(`Guardian configuration error: ${initializationError}`, "error");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify(
					`Guardian is ${config.enabled ? "enabled" : "disabled"}. Reviewer: ${config.reviewerModel}`,
					config.enabled ? "info" : "warning",
				);
				return;
			}
			if (!(["on", "off", "toggle"] as const).includes(requested as "on" | "off" | "toggle")) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /guardian [on|off|toggle|status|costs]", "warning");
				return;
			}
			const enabled = requested === "on" || (requested === "toggle" && !config.enabled);
			let nextPolicyHash = policyHash;
			if (enabled) {
				try {
					nextPolicyHash = hashText(readFileSync(config.policyPath, "utf8"));
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`Guardian cannot be enabled: ${conciseFailure(error)}`, "error");
					return;
				}
			}
			try {
				persistGuardianEnabled(agentDir, enabled);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not update ${configPath}: ${conciseFailure(error)}`, "error");
				return;
			}
			config = { ...config, enabled };
			policyHash = nextPolicyHash;
			initializationError = undefined;
			pendingReviews.clear();
			appendStatus();
			if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, enabled ? "enabled" : "disabled", config.reviewerModel, costText(ctx));
			if (ctx.hasUI) ctx.ui.setStatus(
				"pi-guardian",
				enabled ? `guardian: ${config.reviewerModel}` : "guardian: disabled",
			);
			if (ctx.hasUI) ctx.ui.notify(`Guardian ${enabled ? "enabled" : "disabled"}.`, enabled ? "info" : "warning");
		},
	});

	const setReviewProgress = (ctx: ExtensionContext): void => {
		if (!config || !ctx.hasUI) return;
		const ui = ctx.ui;
		if (activeReviewCount === 0) {
			ui.setWorkingMessage();
			ui.setStatus("pi-guardian", `guardian: ${config.reviewerModel}`);
			return;
		}
		const label = activeReviewCount === 1 ? "1 tool" : `${activeReviewCount} tools`;
		ui.setWorkingMessage(`Guardian reviewing ${label}…`);
		ui.setStatus("pi-guardian", `guardian: reviewing ${label}`);
	};

	const trackReview = (promise: Promise<ReviewExecution>, ctx: ExtensionContext): Promise<ReviewExecution> => {
		activeReviewCount++;
		setReviewProgress(ctx);
		return promise.finally(() => {
			activeReviewCount--;
			setReviewProgress(ctx);
		});
	};

	const withReviewSlot = async (launch: () => Promise<ReviewExecution>): Promise<ReviewExecution> => {
		if (!config) throw new Error("Guardian is not configured");
		if (runningReviewCount >= config.maxParallelReviews) {
			await new Promise<void>((resolve) => reviewSlotWaiters.push(resolve));
		} else {
			runningReviewCount++;
		}
		try {
			return await launch();
		} finally {
			const next = reviewSlotWaiters.shift();
			if (next) next();
			else runningReviewCount--;
		}
	};

	const ensureState = (
		branch: readonly SessionEntry[],
		parentSessionId: string,
		activeConfig: GuardianConfig,
		activePolicyHash: string,
	): GuardianStateV1 => {
		const previousState = findGuardianState(branch);
		if (previousState && stateMatchesConfig(previousState, parentSessionId, activeConfig, activePolicyHash)) {
			return previousState;
		}
		const state = createGuardianState(
			parentSessionId,
			activeConfig,
			activePolicyHash,
			previousState?.generation ?? 0,
		);
		pi.appendEntry(GUARDIAN_STATE_ENTRY, state);
		return state;
	};

	/** Latest UI-capable context; sandbox reviews can arrive during a tool call. */
	let latestCtx: ExtensionContext | undefined;
	let disposeSandboxBroker: (() => void) | undefined;

	/**
	 * The broker's reviewer. It reuses the durable guardian conversation and the
	 * standard four-field contract. It deliberately does not advance guardian's
	 * transcript cursor: a sandbox review is not a reviewed tool call, and moving
	 * the cursor would hide context from the next tool review.
	 */
	const evidenceValidator = (ctx: ExtensionContext, activeConfig: GuardianConfig, state: GuardianStateV1, key: string, toolCallId?: string) => () => {
		const latest = findGuardianState(ctx.sessionManager.getBranch());
		if (config !== activeConfig || !config.enabled || policyHash !== state.policyHash ||
			ctx.sessionManager.getSessionId() !== state.parentSessionId || latestCtx?.sessionManager.getSessionId() !== state.parentSessionId ||
			(latest && latest.guardianSessionId !== state.guardianSessionId) || reviewEvidenceKey(ctx.sessionManager.getBranch(), toolCallId) !== key) {
			throw new Error("Guardian parent evidence or reviewer generation changed while review was queued/running; stale verdict rejected");
		}
	};

	const reviewSandboxException = async (request: SandboxExceptionRequest) => {
		const ctx = latestCtx;
		if (!ctx) throw new Error("no active Pi session context for sandbox review");
		if (!config) throw new Error("guardian is not configured");
		if (!policyHash) throw new Error("guardian policy hash is unavailable");
		const branch = ctx.sessionManager.getBranch();
		const state = ensureState(branch, ctx.sessionManager.getSessionId(), config, policyHash);
		// Full transcript, not a delta: an exception request usually arrives right
		// after guardian reviewed the tool call that is asking, which advances the
		// cursor past the user's authorization. Authorization must be visible here.
		const transcript = renderGuardianTranscript(branch, undefined, config.transcript);
		const assessment = await requestGuardianAssessment(
			config,
			state,
			buildSandboxExceptionPrompt(transcript),
			ctx.signal,
			{ directives: [], evidence: [], ...transcript.reviewContext, action: request },
			evidenceValidator(ctx, config, state, reviewEvidenceKey(branch)),
			usageReporter(ctx),
		);
		return sandboxOutcomeFromAssessment(assessment, request);
	};

	const publishSandboxBrokerIfReady = (ctx: ExtensionContext) => {
		if (!config || initializationError || !config.enabled) return;
		disposeSandboxBroker?.();
		disposeSandboxBroker = undefined;
		try {
			disposeSandboxBroker = publishSandboxBroker(
				createSandboxBroker({
					rules: config.sandboxExceptions,
					projectRules: () => projectRules,
					agentDir: config.agentDir,
					sessionDir: config.guardianSessionDir,
					// Maintenance authority comes from the trusted global config only.
					// Neither the project policy (`projectRules`) nor the request may
					// name a maintenance root.
					maintenanceRoots: config.permissions.agentDirWriteProjects ?? [],
					sessionCwd: ctx.cwd,
					review: reviewSandboxException,
					reviewTool: reviewDelegatedTool,
					audit: (record) => pi.appendEntry(SANDBOX_EXCEPTION_ENTRY, record),
					maxConsecutiveDenials: config.maxConsecutiveDenials,
				}),
			);
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Guardian sandbox broker not published: ${conciseFailure(error)}`, "error");
			}
		}
	};

	const prepareReview = (
		toolName: string,
		toolCallId: string,
		input: Record<string, unknown>,
		cwd: string,
		activeConfig: GuardianConfig,
		state: GuardianStateV1,
		parentSessionId: string,
		transcript: RenderedTranscript,
		signal: AbortSignal | undefined,
		parentActions?: GuardianParentAction[],
		validate?: () => void,
		reportUsage?: (notice: GuardianUsageNotice) => void,
	): PreparedReview => {
		try {
			const action = createAction(toolName, toolCallId, input, cwd);
			if (parentActions) action.parent_actions = parentActions;
			const serializedAction = JSON.stringify(action);
			if (serializedAction.length > activeConfig.maxActionChars) {
				throw new Error(`Planned action is too large to review safely (${serializedAction.length} characters)`);
			}
			return {
				actionHash: hashAction(action),
				canBootstrap: true,
				launch: () => assessAction(activeConfig, state, parentSessionId, transcript, action, signal, validate, reportUsage),
			};
		} catch (error) {
			const failure = conciseFailure(error);
			return {
				actionHash: fallbackActionHash(toolName, toolCallId, input),
				canBootstrap: false,
				launch: async () => ({
					assessment: failedClosedAssessment(failure),
					failure,
					validReview: false,
				}),
			};
		}
	};

	/** One consumption/denial/audit implementation for native and delegated tool review. */
	const consumeToolReview = (options: {
		ctx: ExtensionContext; activeConfig: GuardianConfig; parentSessionId: string;
		state: GuardianStateV1; turnKey: string; cursorEntryId?: string; parentToolCallId?: string;
		toolName: string; toolCallId: string; actionHash: string; execution: ReviewExecution;
		decision: PermissionDecision; validate: () => void;
		delegated?: GuardianAssessmentRecordV1["delegated"];
	}): { block: true; reason: string; terminate?: boolean } | undefined => {
		const { ctx, activeConfig, parentSessionId, turnKey, cursorEntryId, parentToolCallId, toolName, toolCallId, actionHash, decision, delegated } = options;
		let { state } = options;
		let { assessment, failure, validReview } = options.execution;
		if (decision.outcome !== "deny" && validReview) {
			try { options.validate(); }
			catch (error) { failure = conciseFailure(error); assessment = failedClosedAssessment(failure); validReview = false; }
		}
		const latestState = findGuardianState(ctx.sessionManager.getBranch());
		if (config !== activeConfig || !config.enabled || policyHash !== state.policyHash ||
			ctx.sessionManager.getSessionId() !== parentSessionId || latestCtx?.sessionManager.getSessionId() !== parentSessionId ||
			(latestState && latestState.guardianSessionId !== state.guardianSessionId)) {
			return { block: true, reason: denialReason(failedClosedAssessment("Parent session/policy/reviewer generation changed; stale review cannot advance or overwrite its state"), false, true) };
		}
		if (latestState) state = latestState;
		state = updateDenialState(state, turnKey, assessment.outcome === "deny");
		if (validReview) {
			state = { ...state, reviewCount: state.reviewCount + 1,
				// A delegated review cannot consume/hide the parent's transcript cursor.
				...(delegated ? {} : { lastReviewedParentEntryId: cursorEntryId }) };
		}
		const record: GuardianAssessmentRecordV1 = {
			version: STATE_VERSION, guardianSessionId: state.guardianSessionId,
			toolName, toolCallId, actionHash, parentCursorEntryId: cursorEntryId,
			parentToolCallId, ...(delegated ? { delegated } : {}), turnKey, assessment,
			source: decision.outcome === "deny" ? "rule" : "reviewer",
			rule: decision.outcome === "deny" ? decision.rule : undefined,
			reviewedAt: new Date().toISOString(), failure,
			failureHelp: failure ? guardianFailureHelp(failure, configPath) : undefined,
		};
		pi.appendEntry(GUARDIAN_ASSESSMENT_ENTRY, record);
		pi.appendEntry(GUARDIAN_STATE_ENTRY, state);
		if (assessment.outcome !== "deny") return undefined;
		const terminate = state.consecutiveDenials >= activeConfig.maxConsecutiveDenials;
		if (failure) {
			if (ctx.hasUI) ctx.ui.notify(`Guardian review failed and blocked ${toolName}: ${failure}\nFix: ${guardianFailureHelp(failure, configPath)}`, "error");
		} else if (ctx.hasUI) ctx.ui.notify(`Guardian denied ${toolName}: ${assessment.rationale}`, "warning");
		return { block: true, reason: decision.outcome === "deny" ? ruleDenialReason(decision.rule, terminate) : denialReason(assessment, terminate, Boolean(failure)), terminate };
	};

	/** Exact child semantics use the SAME engine, writer queue, state and accounting. No exception is granted. */
	const reviewDelegatedTool = async (request: DelegatedToolRequest): Promise<DelegatedToolDecision> => {
		try {
			const { identity, action, signal: childSignal } = parseDelegatedToolRequest(request);
			const ctx = latestCtx;
			if (!ctx || !config || !config.enabled || initializationError || !policyHash) return { outcome: "unavailable", rationale: "No active parent Guardian tool-review authority" };
			const activeConfig = config;
			const parentSessionId = ctx.sessionManager.getSessionId();
			if (identity.parentSessionId !== parentSessionId) return { outcome: "deny", rationale: "Delegated tool parent does not match the active Guardian session" };
			if (request.action.length > activeConfig.maxActionChars) return { outcome: "deny", rationale: "Exact child action exceeds the parent's configured action budget; nothing was truncated" };
			const signal = ctx.signal && childSignal ? AbortSignal.any([ctx.signal, childSignal]) : childSignal ?? ctx.signal;
			if (signal?.aborted) return { outcome: "cancelled", rationale: "Delegated tool review was cancelled" };
			const branch = ctx.sessionManager.getBranch();
			const state = ensureState(branch, parentSessionId, activeConfig, policyHash);
			const validate = evidenceValidator(ctx, activeConfig, state, reviewEvidenceKey(branch));
			const decision = evaluatePermissions(activeConfig.permissions, action.tool_name, action.input, ctx.cwd, activeConfig.agentDir, action.cwd);
			validate();
			if (decision.outcome === "allow") return { outcome: "allow" };
			const transcript = renderGuardianTranscript(branch, undefined, activeConfig.transcript);
			transcript.reviewContext = { directives: [], ...transcript.reviewContext, evidence: [
				...(transcript.reviewContext?.evidence ?? []),
				{ id: `delegated-${hashText(JSON.stringify({ identity, action }))}`, text: `Host-bound child audience (evidence, not a permission grant): ${JSON.stringify(identity)}` },
			] };
			const prepared = prepareReview(action.tool_name, action.tool_call_id, action.input, action.cwd,
				activeConfig, state, parentSessionId, transcript, signal, action.parent_actions, validate, usageReporter(ctx));
			const execution = decision.outcome === "deny"
				? { assessment: ruleDeniedAssessment(decision.rule), validReview: false }
				: await trackReview(withReviewSlot(prepared.launch), ctx);
			if (signal?.aborted) return { outcome: "cancelled", rationale: "Delegated tool review was cancelled before consumption" };
			const result = consumeToolReview({ ctx, activeConfig, parentSessionId, state,
				turnKey: latestUserTurnKey(branch), toolName: action.tool_name, toolCallId: action.tool_call_id,
				actionHash: prepared.actionHash, execution, decision, validate, delegated: { identity, action } });
			return result ? { outcome: "deny", rationale: result.reason, ...(result.terminate ? { terminate: true } : {}) } : { outcome: "allow" };
		} catch (error) {
			return { outcome: "unavailable", rationale: `Exact delegated tool review failed closed: ${conciseFailure(error)}` };
		}
	};

	pi.on("message_end", (event, ctx) => {
		if (!config || !policyHash || initializationError || !config.enabled) return;
		const activeConfig = config;
		// Rule-decided calls need no speculative review.
		const calls = assistantToolCalls(event.message).filter(
			(call) =>
				evaluatePermissions(activeConfig.permissions, call.toolName, call.input, ctx.cwd, activeConfig.agentDir)
					.outcome === "review",
		);
		if (calls.length === 0) return;

		pendingReviews.clear();
		const branch = ctx.sessionManager.getBranch();
		const parentSessionId = ctx.sessionManager.getSessionId();
		const state = ensureState(branch, parentSessionId, config, policyHash);
		const previewBranch = branchWithPendingAssistant(
			branch,
			event.message,
			calls.map((call) => call.toolCallId),
		);
		const transcript = renderGuardianTranscript(previewBranch, state.lastReviewedParentEntryId, config.transcript);
		const prepared = calls.map((call) => ({
			call,
			review: prepareReview(
				call.toolName,
				call.toolCallId,
				call.input,
				ctx.cwd,
				config!,
				state,
				parentSessionId,
				transcript,
				ctx.signal,
				undefined,
				evidenceValidator(ctx, activeConfig, state, reviewEvidenceKey(previewBranch, call.toolCallId), call.toolCallId),
				usageReporter(ctx),
			),
		}));

		const bootstrapReview = state.reviewCount === 0 ? prepared.find(({ review }) => review.canBootstrap) : undefined;
		const bootstrap = bootstrapReview
			? trackReview(withReviewSlot(bootstrapReview.review.launch), ctx)
			: undefined;
		for (const { call, review } of prepared) {
			let promise: Promise<ReviewExecution>;
			if (bootstrapReview?.call.toolCallId === call.toolCallId) {
				promise = bootstrap!;
			} else if (state.reviewCount === 0 && bootstrap && review.canBootstrap) {
				promise = bootstrap.then((result) => (result.validReview ? withReviewSlot(review.launch) : result));
			} else {
				promise = withReviewSlot(review.launch);
			}
			if (bootstrapReview?.call.toolCallId !== call.toolCallId) promise = trackReview(promise, ctx);
			pendingReviews.set(call.toolCallId, {
				parentSessionId,
				state,
				actionHash: review.actionHash,
				evidenceKey: reviewEvidenceKey(previewBranch, call.toolCallId),
				configSnapshot: activeConfig,
				promise,
			});
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		latestCtx = ctx;
		if (!config) {
			return {
				block: true,
				reason: `Pi Guardian failed to initialize and is blocking tool execution: ${initializationError ?? "unknown configuration error"}`,
				terminate: true,
			};
		}
		if (!config.enabled) return undefined;
		if (initializationError) {
			return {
				block: true,
				reason: `Pi Guardian failed to initialize and is blocking tool execution: ${initializationError}`,
				terminate: true,
			};
		}
		if (!policyHash) return { block: true, reason: "Guardian policy hash is unavailable", terminate: true };
		const sessionId = ctx.sessionManager.getSessionId();
		try {
			activeCalls.set(event.toolCallId, {
				action: createAction(event.toolName, event.toolCallId, event.input, ctx.cwd),
				parentToolCallId: event.parentToolCallId,
				sessionId,
			});
		} catch {
			// Serialization failures fail closed below.
		}
		const decision = evaluatePermissions(config.permissions, event.toolName, event.input, ctx.cwd, config.agentDir);
		if (decision.outcome === "allow") return undefined;
		const ruleExecution: ReviewExecution | undefined =
			decision.outcome === "deny"
				? { assessment: ruleDeniedAssessment(decision.rule), validReview: false }
				: undefined;

		const branch = ctx.sessionManager.getBranch();
		const parentSessionId = ctx.sessionManager.getSessionId();
		let state = ensureState(branch, parentSessionId, config, policyHash);
		const turnKey = latestUserTurnKey(branch);
		let cursorEntryId = findAssistantCursor(branch, event.toolCallId);
		let actionHash = fallbackActionHash(event.toolName, event.toolCallId, event.input);
		let pending = event.parentToolCallId ? undefined : pendingReviews.get(event.toolCallId);
		pendingReviews.delete(event.toolCallId);

		try {
			const built = createActionWithParents({ toolName: event.toolName, toolCallId: event.toolCallId,
				input: event.input, cwd: ctx.cwd, parentToolCallId: event.parentToolCallId,
				branch, activeCalls, sessionId: parentSessionId });
			const action = built.action;
			cursorEntryId = built.cursorEntryId;
			actionHash = hashAction(action);
			if (ruleExecution) {
				pending = { parentSessionId, state, actionHash, promise: Promise.resolve(ruleExecution) };
			} else if (
				!pending ||
				pending.parentSessionId !== parentSessionId ||
				pending.actionHash !== actionHash ||
				pending.state.guardianSessionId !== state.guardianSessionId ||
				pending.evidenceKey !== reviewEvidenceKey(branch, event.toolCallId)
			) {
				const transcript = renderGuardianTranscript(branch, state.lastReviewedParentEntryId, config.transcript);
				const prepared = prepareReview(
					event.toolName,
					event.toolCallId,
					event.input,
					ctx.cwd,
					config,
					state,
					parentSessionId,
					transcript,
					ctx.signal,
					action.parent_actions,
					evidenceValidator(ctx, config, state, reviewEvidenceKey(branch, event.toolCallId), event.toolCallId),
					usageReporter(ctx),
				);
				actionHash = prepared.actionHash;
				pending = {
					parentSessionId,
					state,
					actionHash,
					evidenceKey: reviewEvidenceKey(branch, event.toolCallId),
					configSnapshot: config,
					promise: trackReview(withReviewSlot(prepared.launch), ctx),
				};
			}
		} catch (error) {
			const failure = conciseFailure(error);
			pending = {
				parentSessionId,
				state,
				actionHash,
				promise: Promise.resolve(ruleExecution ?? { assessment: failedClosedAssessment(failure), failure, validReview: false }),
			};
		}

		return consumeToolReview({ ctx, activeConfig: pending.configSnapshot ?? config, parentSessionId, state,
			turnKey, cursorEntryId, parentToolCallId: event.parentToolCallId,
			toolName: event.toolName, toolCallId: event.toolCallId, actionHash,
			execution: await pending.promise, decision,
			validate: evidenceValidator(ctx, pending.configSnapshot ?? config, state, pending.evidenceKey ?? "", event.toolCallId),
		});
	});
}
