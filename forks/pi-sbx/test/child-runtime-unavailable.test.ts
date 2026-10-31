import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

// A missing/incompatible NEW deep helper must not prevent guard publication.
// No host CLI, alternate matcher or ambient-config fallback is substituted.
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js", () => ({
  splitDomainPatternPort: undefined, matchesDomainPatternWithPort: undefined,
}));
import { CHILD_AUTHORITY_PROVIDER_KEY, publishChildAuthority } from "../src/child-authority.ts";

it("a missing SRT helper refuses preparation without reopening a bare launch", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-sbx-helper-missing-")));
  const publication = publishChildAuthority({
    sessionId: "helper-missing-parent", agentDir: join(cwd, "agent"), configDirName: ".pi",
    getBaseline: () => ({ cwd, allowUnsandboxedCommands: false,
      policy: { allowWrite: [cwd], denyWrite: [], denyRead: [], allowRead: [], mandatoryDenyRead: [], mandatoryDenyWrite: [] },
      runtime: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowWrite: [cwd], denyRead: [], denyWrite: [] } },
      environmentDeny: [],
    }),
    getHuman: () => ({ ask: async () => { throw new Error("must not ask"); } }),
    requiredExtensions: [
      { id: "pi-sbx", path: fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
      { id: "pi-guardian", path: fileURLToPath(new URL("../../pi-guardian/src/index.ts", import.meta.url)) },
    ],
    loadRegistration: async () => ({ registerRequiredChildExtensions: () => ({ dispose() {} }) }),
  });
  try {
    await publication.ready;
    const slot = globalThis as Record<PropertyKey, unknown>;
    expect(slot[CHILD_AUTHORITY_PROVIDER_KEY]).toBe(publication.provider);
    await expect(publication.provider.prepare({ parentSessionId: "helper-missing-parent", runId: "run", index: 0, agent: "worker", cwd }, new AbortController().signal)).rejects.toThrow(/incompatible/);
    expect(slot[CHILD_AUTHORITY_PROVIDER_KEY]).toBe(publication.provider);
    await expect(publication.provider.prepare({ parentSessionId: "helper-missing-parent", runId: "run2", index: 0, agent: "worker", cwd }, new AbortController().signal)).rejects.toThrow(/incompatible/);
  } finally { publication.dispose(); }
});
