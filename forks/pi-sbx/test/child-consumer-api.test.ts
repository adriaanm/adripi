import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInstalledChildConsumerApi, mayHaveChildAuthorityContext } from "../src/child-consumer-api.ts";
import { createChildAuthorityLease, withChildAuthority } from "../../pi-subagents/src/runs/shared/child-authority.ts";

const keys = [Symbol.for("pi-subagents.child-authority-lease.v1"), Symbol.for("pi-subagents.child-authority-runner.v1")];
const globals = globalThis as Record<PropertyKey, unknown>;
let saved: Array<PropertyDescriptor | undefined>;
let agentDir: string;
let packageRoot: string;
beforeEach(() => {
  saved = keys.map(key => Object.getOwnPropertyDescriptor(globals, key));
  for (const key of keys) delete globals[key];
  agentDir = mkdtempSync(join(tmpdir(), "sbx-consumer-api-"));
  packageRoot = join(agentDir, "npm/node_modules/pi-subagents");
  mkdirSync(join(packageRoot, "bundle"), { recursive: true });
});
afterEach(() => {
  keys.forEach((key, index) => { if (saved[index]) Object.defineProperty(globals, key, saved[index]!); else delete globals[key]; });
  rmSync(agentDir, { recursive: true, force: true });
});
function install(body: string, entry = "./bundle/authority.js"): void {
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module", exports: { "./child-authority": { default: entry } } }));
  writeFileSync(join(packageRoot, "bundle/authority.js"), body);
}

describe("co-installed public child-authority bridge (not enforcement)", () => {
  it("uses presence only as a tripwire and creates no registry", () => {
    expect(mayHaveChildAuthorityContext()).toBe(false);
    expect(keys.some(key => key in globals)).toBe(false);
    globals[keys[0]] = undefined;
    expect(mayHaveChildAuthorityContext()).toBe(true);
    delete globals[keys[0]];
    globals[keys[1]] = undefined;
    expect(mayHaveChildAuthorityContext()).toBe(true);
  });

  it("fails closed on an absent package instead of inventing an authority API", async () => {
    await expect(loadInstalledChildConsumerApi(agentDir)).rejects.toThrow(/not installed/);
  });

  it("refuses a missing public entry", async () => {
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", exports: {} }));
    await expect(loadInstalledChildConsumerApi(agentDir)).rejects.toThrow(/exposes no.*child-authority/);
  });

  it("refuses an old API even when its method names look right", async () => {
    install("export const CHILD_AUTHORITY_PROVIDER_VERSION=1; export function hasChildAuthorityContext(){}; export function claimChildAuthority(){}; export function acknowledgeChildAuthority(){};");
    await expect(loadInstalledChildConsumerApi(agentDir)).rejects.toThrow(/incompatible/);
  });

  it("refuses a partial API and never supplies missing methods", async () => {
    install("export const CHILD_AUTHORITY_PROVIDER_VERSION=2; export function hasChildAuthorityContext(){};");
    await expect(loadInstalledChildConsumerApi(agentDir)).rejects.toThrow(/malformed/);
  });

  it("refuses a package-export escape before loading its code", async () => {
    install("throw new Error('the wrong entry ran')", "../../outside.js");
    await expect(loadInstalledChildConsumerApi(agentDir)).rejects.toThrow(/escapes its package root/);
  });

  it("claims/acks the actual public API's live ALS lease, not JSON or a parallel registry", async () => {
    install(`export * from ${JSON.stringify(new URL("../../pi-subagents/src/api/child-authority.ts", import.meta.url).href)};`);
    const api = await loadInstalledChildConsumerApi(agentDir);
    expect(api.hasChildAuthorityContext()).toBe(false);
    globals[keys[0]] = undefined;
    expect(() => api.hasChildAuthorityContext()).toThrow(/malformed/);
    delete globals[keys[0]];
    expect(() => api.claimChildAuthority("pi-sbx", agentDir)).toThrow(/active withChildAuthority/);
    const handle = createChildAuthorityLease({ leaseId: "bridge-fixture", identity: {
      parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: agentDir },
      payload: {}, requiredConsumers: ["pi-sbx", "pi-guardian"], send: () => false, cancel: () => {}, requestTimeoutMs: 100 });
    try {
      withChildAuthority(handle.lease, () => {
        const sbx = api.claimChildAuthority("pi-sbx", agentDir);
        const guardian = api.claimChildAuthority("pi-guardian", agentDir);
        expect(sbx).toBe(handle.lease);
        expect(guardian).toBe(sbx);
        api.acknowledgeChildAuthority("pi-sbx");
        expect(() => sbx.assertReady()).toThrow(/pi-guardian/);
        api.acknowledgeChildAuthority("pi-guardian");
        expect(() => sbx.assertReady()).not.toThrow();
      });
      expect(api.hasChildAuthorityContext()).toBe(false);
    } finally { handle.lease.dispose(); }
  });
});
