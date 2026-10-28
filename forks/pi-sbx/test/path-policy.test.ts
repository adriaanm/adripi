import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeTarget, canRead, canTraverse, canWrite, createFilePolicy, resolveReadTarget, type FilePolicy } from "../src/path-policy.ts";

function policy(root: string): FilePolicy {
  return {
    denyRead: [join(root, "secret")],
    allowRead: [join(root, "secret", "public")],
    allowWrite: [root],
    denyWrite: [join(root, "*.key")],
    mandatoryDenyWrite: [join(root, ".pi")],
  };
}

describe("path policy", () => {
  it("applies read exceptions and write denies", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-path-"));
    const p = policy(root);
    expect(canRead(join(root, "normal.txt"), root, p)).toBe(true);
    expect(canRead(join(root, "secret", "token"), root, p)).toBe(false);
    expect(canRead(join(root, "secret", "public", "note"), root, p)).toBe(true);
    expect(canWrite(join(root, "normal.txt"), root, p)).toBe(true);
    expect(canWrite(join(root, "private.key"), root, p)).toBe(false);
    expect(canWrite(join(root, ".pi", "sandbox.json"), root, p)).toBe(false);
  });

  it("canonicalizes existing and non-existing paths through symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-link-"));
    const outside = mkdtempSync(join(tmpdir(), "pi-sbx-out-"));
    mkdirSync(join(root, "dir"));
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(root, "dir", "link"));
    const canonicalOutside = realpathSync.native(outside);
    expect(canonicalizeTarget(join(root, "dir", "link", "secret"), root)).toBe(join(canonicalOutside, "secret"));
    expect(canonicalizeTarget(join(root, "dir", "link", "new"), root)).toBe(join(canonicalOutside, "new"));
  });

  it("fails closed when traversal can enter a denied subtree", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-traverse-"));
    expect(canTraverse(root, root, policy(root))).toBe(false);
  });

  it("resolves only the first path Pi read would actually open", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-read-path-"));
    const literal = join(root, "don't.txt");
    const curly = join(root, "don’t.txt");
    writeFileSync(literal, "literal");
    writeFileSync(curly, "curly");
    expect(resolveReadTarget(literal, root)).toBe(realpathSync.native(literal));

    const missingLiteral = join(root, "isn't.txt");
    const fallback = join(root, "isn’t.txt");
    writeFileSync(fallback, "fallback");
    expect(resolveReadTarget(missingLiteral, root)).toBe(realpathSync.native(fallback));
  });

  it("denies credential files for built-in tools regardless of credential mode", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-credentials-"));
    const credentials = [join(root, "token"), join(root, "masked")];
    const p = createFilePolicy({
      filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      credentialFiles: credentials.map((path) => ({ path })),
      mandatoryDenyWrite: [],
    });
    expect(canRead(credentials[0]!, root, p)).toBe(false);
    expect(canRead(credentials[1]!, root, p)).toBe(false);
  });
});

describe("denied realpath", () => {
  it("falls back instead of throwing when the sandbox denies realpath", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sbx-realpath-"));
    const file = join(root, "secret", "auth.json");
    mkdirSync(join(root, "secret"), { recursive: true });
    writeFileSync(file, "{}");
    const fsPolicy = policy(root);
    const spy = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted, realpath"), { code: "EPERM" });
    });
    try {
      expect(() => canWrite(file, root, fsPolicy)).not.toThrow();
      expect(canWrite(file, root, fsPolicy)).toBe(true);
      expect(() => canRead(join(root, "secret", "x"), root, fsPolicy)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
