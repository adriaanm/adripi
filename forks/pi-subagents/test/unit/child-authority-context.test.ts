import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, test } from "node:test";
import {
  CHILD_AUTHORITY_LEASE_SLOT_KEY, CHILD_AUTHORITY_RUNNER_LATCH_KEY,
  createChildAuthorityLease, hasChildAuthorityContext, withChildAuthority,
} from "../../src/runs/shared/child-authority.ts";
import { childAuthorityRunnerLatched, nestedChildAuthorityRefusal } from "../../src/runs/shared/child-authority-launch.ts";
import { hasChildAuthorityContext as publicCheck } from "../../src/api/child-authority.ts";

const root = globalThis as Record<PropertyKey, unknown>;
const keys = [CHILD_AUTHORITY_LEASE_SLOT_KEY, CHILD_AUTHORITY_RUNNER_LATCH_KEY];
const originals = keys.map(key => Object.getOwnPropertyDescriptor(root, key));
afterEach(() => { keys.forEach((key, index) => { delete root[key]; if (originals[index]) Object.defineProperty(root, key, originals[index]!); }); });
function clear() { for (const key of keys) delete root[key]; }

test("ordinary root dispatch does not create a lease registry or need a launcher service", () => {
  clear(); assert.equal(publicCheck, hasChildAuthorityContext);
  assert.equal(hasChildAuthorityContext(), false);
  for (const key of keys) assert.equal(key in root, false);
});

test("only a live code-only ALS scope dispatches as child; valid inactive storage is not authority", async () => {
  clear();
  root[CHILD_AUTHORITY_LEASE_SLOT_KEY] = { version: 1, storage: new AsyncLocalStorage() };
  assert.equal(hasChildAuthorityContext(), false);
  const { lease } = createChildAuthorityLease({ leaseId: "context-lease",
    identity: { parentSessionId: "parent", runId: "run", agent: "worker", index: 0, cwd: process.cwd() },
    payload: { kind: "context-test" }, requiredConsumers: [], requestTimeoutMs: 1000,
    send: () => false, cancel() {},
  });
  try {
    await withChildAuthority(lease, async () => {
      assert.equal(hasChildAuthorityContext(), true); await Promise.resolve();
      assert.equal(hasChildAuthorityContext(), true);
    });
    assert.equal(hasChildAuthorityContext(), false);
  } finally { lease.dispose(); }
});

test("malformed or explicitly undefined ALS registry refuses instead of entering root mode", () => {
  clear();
  for (const value of [undefined, null, {}, { version: 2, storage: new AsyncLocalStorage() }, { version: 1, storage: { getStore: () => undefined } }]) {
    root[CHILD_AUTHORITY_LEASE_SLOT_KEY] = value;
    assert.throws(() => hasChildAuthorityContext(), { code: "service-malformed" });
  }
});

test("runner intent survives scope exit/malformed/undefined values and never reopens nested or root placement", () => {
  clear();
  for (const value of [undefined, null, false, {}, { version: 1, latchedAt: 1 }]) {
    root[CHILD_AUTHORITY_RUNNER_LATCH_KEY] = value;
    assert.equal(hasChildAuthorityContext(), true);
    assert.equal(childAuthorityRunnerLatched(), true);
    assert.match(nestedChildAuthorityRefusal("parent")!, /guarded child authority runner/);
    assert.match(nestedChildAuthorityRefusal("runner")!, /guarded child authority runner/);
  }
});
