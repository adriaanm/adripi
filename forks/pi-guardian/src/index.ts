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
import { loadGuardianConfig, persistGuardianEnabled } from "./config.ts";
import { evaluatePermissions } from "./permissions.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { requestGuardianAssessment } from "./sidecar.ts";
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

function cloneToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const serialized = JSON.stringify(input);
	if (serialized === undefined) throw new Error("Tool input could not be serialized");
	return JSON.parse(serialized) as Record<string, unknown>;
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

function createAction(
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
	cwd: string,
): GuardianAction {
	return { tool_name: toolName, tool_call_id: toolCallId, input: cloneToolInput(input), cwd };
}

async function assessAction(
	config: GuardianConfig,
	state: GuardianStateV1,
	parentSessionId: string,
	transcript: RenderedTranscript,
	action: GuardianAction,
	signal: AbortSignal | undefined,
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
			),
			validReview: true,
		};
	} catch (error) {
		const failure = conciseFailure(error);
		return { assessment: failedClosedAssessment(failure), failure, validReview: false };
	}
}

function assistantToolCalls(message: unknown): Array<{
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}> {
	if (!message || typeof message !== "object") return [];
	const value = message as Record<string, unknown>;
	if (
		value.role !== "assistant" ||
		value.stopReason === "length" ||
		value.stopReason === "error" ||
		value.stopReason === "aborted" ||
		!Array.isArray(value.content)
	) {
		return [];
	}
	const calls: Array<{ toolName: string; toolCallId: string; input: Record<string, unknown> }> = [];
	for (const item of value.content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (
			block.type === "toolCall" &&
			typeof block.name === "string" &&
			typeof block.id === "string" &&
			block.arguments !== null &&
			typeof block.arguments === "object" &&
			!Array.isArray(block.arguments)
		) {
			calls.push({
				toolName: block.name,
				toolCallId: block.id,
				input: block.arguments as Record<string, unknown>,
			});
		}
	}
	return calls;
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

function findAssistantCursor(branch: readonly SessionEntry[], toolCallId: string): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (
			message.content.some(
				(item) =>
					Boolean(item) &&
					typeof item === "object" &&
					(item as Record<string, unknown>).type === "toolCall" &&
					(item as Record<string, unknown>).id === toolCallId,
			)
		) {
			return entry.id;
		}
	}
	return undefined;
}

export default function guardianExtension(pi: ExtensionAPI) {
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

	pi.on("session_start", (_event, ctx) => {
		activeCalls.clear();
		appendStatus();
		// Pi 1.0 print mode subscribes after session_start. Replay once at input.
		replayStatus = ctx.mode === "json";
		if (!ctx.hasUI) return;
		if (config && !config.enabled) {
			if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, "disabled", config.reviewerModel);
			ctx.ui.setStatus("pi-guardian", "guardian: disabled");
			return;
		}
		if (initializationError) {
			if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, "error", config?.reviewerModel);
			ctx.ui.setStatus("pi-guardian", "guardian: configuration error");
			ctx.ui.notify(
				`Pi Guardian will fail closed: ${initializationError}\nFix: check ${configPath}, then restart Pi.`,
				"error",
			);
			return;
		}
		if (!config) return;
		if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, "enabled", config.reviewerModel);
		ctx.ui.setStatus("pi-guardian", `guardian: ${config.reviewerModel}`);
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
		description: "Toggle or inspect Pi Guardian (on, off, toggle, status)",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "toggle", "status"];
			const matches = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase() || "toggle";
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
				if (ctx.hasUI) ctx.ui.notify("Usage: /guardian [on|off|toggle|status]", "warning");
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
			if (ctx.mode === "tui") setGuardianStatusWidget(ctx.ui, enabled ? "enabled" : "disabled", config.reviewerModel);
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
				launch: () => assessAction(activeConfig, state, parentSessionId, transcript, action, signal),
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
				promise,
			});
		}
	});

	pi.on("tool_call", async (event, ctx) => {
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
			const parentActions: GuardianParentAction[] = [];
			let parentId = event.parentToolCallId;
			const seen = new Set([event.toolCallId]);
			while (parentId) {
				if (seen.has(parentId)) throw new Error("Nested tool parent chain contains a cycle");
				seen.add(parentId);
				const parentCursor = findAssistantCursor(branch, parentId);
				if (parentCursor) {
					const entry = branch.find((entry) => entry.id === parentCursor)!;
					const call = assistantToolCalls(entry.type === "message" ? entry.message : undefined)
						.find((call) => call.toolCallId === parentId);
					if (!call) throw new Error(`Could not locate parent tool call ${parentId}`);
					parentActions.unshift({ tool_name: call.toolName, tool_call_id: call.toolCallId, input: cloneToolInput(call.input) });
					cursorEntryId = parentCursor;
					break;
				}
				const parent = activeCalls.get(parentId);
				if (!parent || parent.sessionId !== parentSessionId || !parent.parentToolCallId) {
					throw new Error(`Could not locate parent tool call ${parentId} in the active transcript`);
				}
				parentActions.unshift(parent.action);
				parentId = parent.parentToolCallId;
			}
			const action = createAction(event.toolName, event.toolCallId, event.input, ctx.cwd);
			if (event.parentToolCallId) action.parent_actions = parentActions;
			actionHash = hashAction(action);
			if (ruleExecution) {
				pending = { parentSessionId, state, actionHash, promise: Promise.resolve(ruleExecution) };
			} else if (
				!pending ||
				pending.parentSessionId !== parentSessionId ||
				pending.actionHash !== actionHash ||
				pending.state.guardianSessionId !== state.guardianSessionId
			) {
				const snapshot = cursorEntryId ? branch.slice(0, branch.findIndex((entry) => entry.id === cursorEntryId) + 1) : branch;
				const transcript = renderGuardianTranscript(snapshot, state.lastReviewedParentEntryId, config.transcript);
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
				);
				actionHash = prepared.actionHash;
				pending = {
					parentSessionId,
					state,
					actionHash,
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

		const { assessment, failure, validReview } = await pending.promise;
		const latestState = findGuardianState(ctx.sessionManager.getBranch());
		if (latestState && latestState.guardianSessionId === state.guardianSessionId) state = latestState;
		state = updateDenialState(state, turnKey, assessment.outcome === "deny");
		if (validReview) {
			state = {
				...state,
				lastReviewedParentEntryId: cursorEntryId,
				reviewCount: state.reviewCount + 1,
			};
		}
		const record: GuardianAssessmentRecordV1 = {
			version: STATE_VERSION,
			guardianSessionId: state.guardianSessionId,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			actionHash,
			parentCursorEntryId: cursorEntryId,
			parentToolCallId: event.parentToolCallId,
			turnKey,
			assessment,
			source: decision.outcome === "deny" ? "rule" : "reviewer",
			rule: decision.outcome === "deny" ? decision.rule : undefined,
			reviewedAt: new Date().toISOString(),
			failure,
			failureHelp: failure ? guardianFailureHelp(failure, configPath) : undefined,
		};
		pi.appendEntry(GUARDIAN_ASSESSMENT_ENTRY, record);
		pi.appendEntry(GUARDIAN_STATE_ENTRY, state);

		if (assessment.outcome !== "deny") return undefined;
		const terminate = state.consecutiveDenials >= config.maxConsecutiveDenials;
		if (failure) {
			if (ctx.hasUI) ctx.ui.notify(
				`Guardian review failed and blocked ${event.toolName}: ${failure}\nFix: ${guardianFailureHelp(failure, configPath)}`,
				"error",
			);
		} else {
			if (ctx.hasUI) ctx.ui.notify(`Guardian denied ${event.toolName}: ${assessment.rationale}`, "warning");
		}
		const reason = decision.outcome === "deny" ? ruleDenialReason(decision.rule, terminate) : denialReason(assessment, terminate, Boolean(failure));
		return { block: true, reason, terminate };
	});
}
