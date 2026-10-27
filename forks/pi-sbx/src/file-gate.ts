import { lstatSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { FilePolicy } from "./path-policy.ts";
import { canonicalizeTarget, canRead, canTraverse, canWrite, resolveReadTarget, resolveTarget } from "./path-policy.ts";

export function registerFileGate(
  pi: ExtensionAPI,
  getPolicy: () => { cwd: string; policy: FilePolicy; enabled: boolean } | undefined,
): void {
  pi.on("tool_call", async (event) => {
    const current = getPolicy();
    if (!current) return;
    const { cwd, policy, enabled } = current;

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const lexicalTarget = resolveTarget(event.input.path, cwd);
      const target = canonicalizeTarget(event.input.path, cwd);
      const mandatoryBlocked = [lexicalTarget, target].some((candidate) =>
        policy.mandatoryDenyWrite.some((pattern) =>
          !canWrite(candidate, cwd, { ...policy, allowWrite: ["/"], denyWrite: [], mandatoryDenyWrite: [pattern] }),
        ),
      );
      if (mandatoryBlocked || (enabled && !canWrite(target, cwd, policy))) {
        return { block: true, reason: `Sandbox policy blocks writing ${event.input.path}` };
      }
      return;
    }
    if (!enabled) return;

    if (isToolCallEventType("read", event)) {
      const target = resolveReadTarget(event.input.path, cwd);
      if (!canRead(target, cwd, policy)) return { block: true, reason: `Sandbox policy blocks reading ${event.input.path}` };
      return;
    }

    if (isToolCallEventType("grep", event)) {
      const raw = event.input.path ?? cwd;
      const target = canonicalizeTarget(raw, cwd);
      let directory = true;
      try { directory = lstatSync(target).isDirectory(); } catch { /* built-in tool reports missing path */ }
      const blocked = directory ? !canTraverse(target, cwd, policy) : !canRead(target, cwd, policy);
      if (blocked) return { block: true, reason: `Sandbox policy blocks searching ${raw}` };
      return;
    }

    if (isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
      const raw = event.input.path ?? cwd;
      const target = canonicalizeTarget(raw, cwd);
      if (!canTraverse(target, cwd, policy)) return { block: true, reason: `Sandbox policy blocks traversing ${raw}` };
    }
  });
}
