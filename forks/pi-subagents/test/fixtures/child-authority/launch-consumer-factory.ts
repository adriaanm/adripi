// Controlled code-only consumer for the guarded background launch regression.
//
// The detached runner imports this module as its child session factory. It claims and acknowledges the
// live lease the host prepared (through the real `withChildAuthority` scope the runner enters), records
// launch evidence for the parent test, and replays one assistant message. It is a fixture, not a
// pi-sbx or Guardian implementation: it has no policy of its own and only proves who may reach a prompt.
import * as fs from "node:fs";
import * as path from "node:path";
import { acknowledgeChildAuthority, claimChildAuthority } from "../../../src/runs/shared/child-authority.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "../../../src/runs/shared/child-session.ts";

type Listener = (event: ChildSessionEvent) => void;

function evidence(line: Record<string, unknown>): void {
	const dir = process.env.CHILD_AUTHORITY_LAUNCH_EVIDENCE;
	if (!dir) throw new Error("CHILD_AUTHORITY_LAUNCH_EVIDENCE is required for the launch consumer fixture.");
	fs.appendFileSync(path.join(dir, "launch-evidence.jsonl"), `${JSON.stringify({ ...line, pid: process.pid })}\n`, "utf-8");
}

function createSession(launch: ChildSessionLaunch): ChildSession {
	const listeners = new Set<Listener>();
	const emit = (event: ChildSessionEvent): void => {
		for (const listener of listeners) listener(event);
	};
	let promptSeen = false;
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string) {
			if (promptSeen) throw new Error("The launch consumer fixture accepts one prompt.");
			promptSeen = true;
			evidence({ event: "prompt", agent: launch.runtime.agent, cwd: launch.cwd, text });
			emit({ type: "agent_start" });
			emit({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "admitted child" }], stopReason: "stop" },
			});
			emit({ type: "agent_settled" });
		},
		async steer() {},
		async followUp() {},
		async abort() {
			evidence({ event: "abort", agent: launch.runtime.agent });
		},
		async dispose() {
			evidence({ event: "dispose", agent: launch.runtime.agent });
		},
		get messages() { return []; },
		sessionFile: undefined,
		sessionId: "launch-consumer-session",
		modelId: launch.model,
	};
}

/** Consumers to claim but not acknowledge: the first-prompt readiness negative for a real launch. */
function skippedAcknowledgements(): Set<string> {
	return new Set((process.env.CHILD_AUTHORITY_LAUNCH_SKIP_ACK ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export default function createLaunchConsumerFactory(): ChildSessionFactory {
	return {
		async create(launch) {
			// Reaching this point means the host loaded the child inside withChildAuthority.
			const skipAck = skippedAcknowledgements();
			const lease = claimChildAuthority("pi-sbx", launch.cwd);
			for (const consumerId of lease.requiredConsumers) {
				if (consumerId !== "pi-sbx") claimChildAuthority(consumerId, launch.cwd);
				if (!skipAck.has(consumerId)) acknowledgeChildAuthority(consumerId);
			}
			evidence({ event: "create", agent: launch.runtime.agent, cwd: launch.cwd });
			// Optional fixture requests exercise the real parent route over the launcher's
			// live channel. They perform no filesystem operation and confer no authority.
			const requests = JSON.parse(process.env.CHILD_AUTHORITY_LAUNCH_REQUESTS ?? "[]") as Array<{ surface: "write"; target: string; reason: string }>;
			for (const request of requests) {
				evidence({ event: "decision", target: request.target, decision: await lease.request(request) });
			}
			return createSession(launch);
		},
		async dispose() {},
	};
}
