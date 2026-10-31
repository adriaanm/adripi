// Real Node IPC fixture: a raw peer that speaks the wire protocol directly, for protocol negatives.
interface PeerStep {
	/** Overrides applied to the base request envelope. */
	overrides?: Record<string, unknown>;
	/** Envelope keys removed before sending (for malformed-shape cases). */
	drop?: string[];
	/** Send a value that is not an envelope at all. */
	raw?: unknown;
	/** Action used when no override replaces it. */
	action?: { surface: string; target: string; reason: string };
	requestId?: string;
	delayMs?: number;
	/** Set false for a step that must not produce a decision (replay, foreign audience, malformed). */
	waitForDecision?: boolean;
}

interface PeerConfig {
	leaseTimeoutMs?: number;
	waitMs?: number;
	/** Wait for each decision before sending the next step, so the parent stays at one request in flight. */
	sequential?: boolean;
	stepTimeoutMs?: number;
	steps?: PeerStep[];
}

const config = JSON.parse(process.argv[2] ?? "{}") as PeerConfig;

const grant: Record<string, unknown> = {};
const received: Array<{ kind: unknown; requestId: unknown; decision: unknown }> = [];
const revokes: unknown[] = [];

process.on("message", (message: unknown) => {
	if (!message || typeof message !== "object") return;
	const envelope = message as { kind?: unknown; sessionId?: string; runId?: string; leaseId?: string; requestId?: unknown; decision?: unknown };
	if (envelope.kind === "child-authority:lease") {
		grant.sessionId = envelope.sessionId;
		grant.runId = envelope.runId;
		grant.leaseId = envelope.leaseId;
	}
	if (envelope.kind === "child-authority:decision") received.push({ kind: envelope.kind, requestId: envelope.requestId, decision: envelope.decision });
	if (envelope.kind === "child-authority:revoke") revokes.push(envelope.leaseId);
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(decisions: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (received.length < decisions && Date.now() < deadline) await sleep(1);
}

function finish(payload: Record<string, unknown>): void {
	process.stdout.write(`AUTHORITY_RESULT ${JSON.stringify({ pid: process.pid, ...payload })}\n`, () => process.exit(0));
}

async function main(): Promise<void> {
	const deadline = Date.now() + (config.leaseTimeoutMs ?? 20_000);
	while (grant.leaseId === undefined) {
		if (Date.now() >= deadline) {
			finish({ error: "no-lease" });
			return;
		}
		await sleep(5);
	}
	let index = 0;
	let expectedDecisions = 0;
	for (const step of config.steps ?? []) {
		index += 1;
		if (step.raw !== undefined) {
			process.send?.(step.raw);
		} else {
			const envelope: Record<string, unknown> = {
				kind: "child-authority:request",
				version: 2,
				sessionId: grant.sessionId,
				runId: grant.runId,
				leaseId: grant.leaseId,
				requestId: step.requestId ?? `peer-request-${index}`,
				action: step.action ?? { surface: "write", target: "/workspace/file.txt", reason: "peer fixture request" },
			};
			for (const key of step.drop ?? []) delete envelope[key];
			process.send?.({ ...envelope, ...step.overrides });
		}
		if (step.waitForDecision !== false) expectedDecisions += 1;
		if (config.sequential) await waitFor(expectedDecisions, config.stepTimeoutMs ?? 5_000);
		if (step.delayMs) await sleep(step.delayMs);
	}
	await sleep(config.waitMs ?? 300);
	finish({ grant, received, revokes });
}

void main();
