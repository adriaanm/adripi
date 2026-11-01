import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerChildNativeTools, type ChildNativeAuthority } from "../src/child-native-tools.ts";
import { authorizePathAction, type PathAction } from "../src/path-authorizer.ts";
import { canonicalizeTarget, createFilePolicy } from "../src/path-policy.ts";

const hooks = vi.hoisted(() => ({ afterMime: undefined as undefined | (() => Promise<void>), afterRead: undefined as undefined | (() => Promise<void>) }));
vi.mock("@earendil-works/pi-coding-agent", async load => {
  const sdk = await load<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, detectSupportedImageMimeTypeFromFile: async (path: string) => {
    const value = await sdk.detectSupportedImageMimeTypeFromFile(path);
    const hook = hooks.afterMime; hooks.afterMime = undefined; await hook?.(); return value;
  } };
});
vi.mock("node:fs/promises", async load => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args); const hook = hooks.afterRead; hooks.afterRead = undefined; await hook?.(); return value;
  } };
});

let root: string;
let active: boolean;
let abort: AbortController;
let policy: ReturnType<typeof createFilePolicy>;
let afterAdmission: undefined | (() => Promise<void>);
const calls: PathAction[] = [];
const tools = new Map<string, { parameters: unknown; renderCall?: unknown; execute: (...args: any[]) => Promise<any> }>();
let authority: ChildNativeAuthority;
let ctx: ExtensionContext;
const invoke = (name: string, input: object, signal?: AbortSignal) => tools.get(name)!.execute("native-operation", input, signal, undefined, ctx);
const text = (result: { content: Array<{ text?: string }> }) => result.content.map(block => block.text ?? "").join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sbx-native-adapter-")); active = true; abort = new AbortController();
  hooks.afterMime = hooks.afterRead = undefined; afterAdmission = undefined; calls.length = 0; tools.clear();
  policy = createFilePolicy({ filesystem: { allowWrite: [canonicalizeTarget(root, root)], denyRead: [], allowRead: [], denyWrite: [] }, mandatoryDenyWrite: [] });
  ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => "native-fixture", getSessionFile: () => undefined } } as unknown as ExtensionContext;
  authority = {
    signal: abort.signal,
    assertActive(eventContext) { if (!active || abort.signal.aborted || eventContext.cwd !== root) throw new Error("authority inactive"); },
    filePolicy: () => policy,
    async authorizePath(action, context, signal) {
      calls.push(action);
      // Real shared feasibility/path engine, fixture current-parent binding.
      // This test does not claim/ack consumers or establish SRT/IPC composition.
      const result = await authorizePathAction(action, { cwd: context.cwd, policy, signal,
        decide: async () => ({ kind: "deny", reason: "fixture parent refused", review: { source: "rule", rationale: "fixture parent refused" } }),
        human: { ask: async () => ({ kind: "unavailable", reason: "no child UI" }) } });
      const callback = afterAdmission; afterAdmission = undefined; await callback?.(); return result;
    },
  };
  registerChildNativeTools({ registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition as any) } as unknown as ExtensionAPI, authority);
});
afterEach(async () => { hooks.afterMime = hooks.afterRead = undefined; await rm(root, { recursive: true, force: true }); });

describe("real SDK native builders with operation-local child fences (authority fixture)", () => {
  it("preserves all six native schemas and removes speculative edit disk preview", () => {
    for (const build of [createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition]) {
      const original = build(root); expect(tools.get(original.name)!.parameters).toEqual(original.parameters);
    }
    expect(tools.get("edit")!.renderCall).toBeUndefined();
  });
  it("reads through the actual SDK text backend at the admitted canonical target", async () => {
    await writeFile(join(root, "file"), "real SDK content\n");
    expect(text(await invoke("read", { path: "file" }))).toContain("real SDK content");
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ surface: "read", target: canonicalizeTarget(join(root, "file"), root) });
  });
  it("writes new nested files without changing the native builder/schema", async () => {
    await invoke("write", { path: "nested/deeper/file", content: "new content" });
    expect(await readFile(join(root, "nested/deeper/file"), "utf8")).toBe("new content");
    expect(calls.map(call => call.surface)).toEqual(["write"]);
  });
  it("writes through a stable final symlink using only the admitted target's parent", async () => {
    await mkdir(join(root, "destination")); await writeFile(join(root, "destination/file"), "old");
    await symlink(join(root, "destination/file"), join(root, "alias"));
    await invoke("write", { path: "alias", content: "new" });
    expect(await readFile(join(root, "destination/file"), "utf8")).toBe("new");
  });
  it.each(["/proc/self/environ", "/sys/kernel", "/dev/fd/0"])("refuses native host process/device access at %s before IO or parent admission", async path => {
    await expect(invoke("read", { path })).rejects.toThrow(/never grantable/);
    expect(calls).toHaveLength(0);
  });
  it("uses the genuine multi-edit backend and independently admits read AND write", async () => {
    await writeFile(join(root, "file"), "alpha beta\n");
    const result = await invoke("edit", { path: "file", edits: [{ oldText: "alpha", newText: "gamma" }, { oldText: "beta", newText: "delta" }] });
    expect(await readFile(join(root, "file"), "utf8")).toBe("gamma delta\n");
    expect(calls.map(call => call.surface)).toEqual(["read", "write"]);
    expect(result.details.diff).toContain("gamma delta");
  });
  it("does not read a mandatory-read-denied file through write-only edit authority", async () => {
    const file = join(root, "secret"); await writeFile(file, "not an edit oracle");
    policy.mandatoryDenyRead.push(canonicalizeTarget(file, root));
    await expect(invoke("edit", { path: file, edits: [{ oldText: "not", newText: "yes" }] })).rejects.toThrow(/never grantable/);
    expect(calls).toHaveLength(0); expect(await readFile(file, "utf8")).toBe("not an edit oracle");
  });
  it("rejects impossible write authority before asking for edit read scope", async () => {
    const file = join(root, "locked"); await writeFile(file, "unchanged"); policy.denyWrite.push(canonicalizeTarget(file, root));
    await expect(invoke("edit", { path: file, edits: [{ oldText: "unchanged", newText: "changed" }] })).rejects.toThrow(/deny-write/);
    expect(calls).toHaveLength(0); expect(await readFile(file, "utf8")).toBe("unchanged");
  });
  it("cannot borrow unheld write authority from the adapter itself", async () => {
    policy.allowWrite = [];
    await expect(invoke("write", { path: "not-created", content: "no" })).rejects.toThrow(/parent refused/);
    await expect(stat(join(root, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses aliases switched during asynchronous admission", async () => {
    await writeFile(join(root, "first"), "first"); await writeFile(join(root, "second"), "second");
    const alias = join(root, "alias"); await symlink(join(root, "first"), alias);
    afterAdmission = async () => { await unlink(alias); await symlink(join(root, "second"), alias); };
    await expect(invoke("read", { path: alias })).rejects.toThrow(/target changed/);
  });
  it("rechecks read scope after MIME detection and before the subsequent data read", async () => {
    await writeFile(join(root, "first"), "first"); await writeFile(join(root, "second"), "must not return");
    const alias = join(root, "alias"); await symlink(join(root, "first"), alias);
    hooks.afterMime = async () => { await unlink(alias); await symlink(join(root, "second"), alias); };
    await expect(invoke("read", { path: alias })).rejects.toThrow(/target changed/);
  });
  it("rechecks edit scope after its real disk read and before any write", async () => {
    const first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias");
    await writeFile(first, "old"); await writeFile(second, "preserve"); await symlink(first, alias);
    hooks.afterRead = async () => { await unlink(alias); await symlink(second, alias); };
    await expect(invoke("edit", { path: alias, edits: [{ oldText: "old", newText: "new" }] })).rejects.toThrow(/target changed/);
    expect(await readFile(first, "utf8")).toBe("old"); expect(await readFile(second, "utf8")).toBe("preserve");
  });
  it("discards pending admission on revocation before native IO", async () => {
    afterAdmission = async () => { active = false; };
    await expect(invoke("write", { path: "not-created", content: "no" })).rejects.toThrow(/inactive/);
    await expect(stat(join(root, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks caller cancellation before creating parent directories", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(invoke("write", { path: "nested/file", content: "no" }, cancelled.signal)).rejects.toThrow(/cancelled/);
    await expect(stat(join(root, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks the event context signal independently of the SDK execute argument", async () => {
    const cancelled = new AbortController(); cancelled.abort(); ctx = { ...ctx, signal: cancelled.signal };
    await expect(invoke("write", { path: "nested/file", content: "no" })).rejects.toThrow(/cancelled/);
    await expect(stat(join(root, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks lease cancellation between SDK read operations", async () => {
    await writeFile(join(root, "file"), "must not return"); hooks.afterMime = async () => { abort.abort(); };
    await expect(invoke("read", { path: "file" })).rejects.toThrow(/inactive|cancelled|aborted/);
  });
  it("lists held directories through the actual SDK Node backend", async () => {
    await mkdir(join(root, "directory")); await writeFile(join(root, "file"), "content");
    const result = text(await invoke("ls", {})); expect(result).toContain("directory/"); expect(result).toContain("file");
    expect(calls.map(call => call.surface)).toEqual(["read"]);
  });
  it("never turns an exact readable grant into denied recursive traversal", async () => {
    policy.denyRead.push(join(canonicalizeTarget(root, root), "private"));
    await expect(invoke("ls", {})).rejects.toThrow(/traversal/); expect(calls).toHaveLength(0);
  });
  it("does not follow listed symlinks to obtain metadata outside the admitted tree", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sbx-native-ls-outside-"));
    try {
      await symlink(outside, join(root, "link"));
      const result = text(await invoke("ls", {})); expect(result).toBe("(empty directory)");
      // The SDK drops an entry whose metadata operation refuses; no outside
      // stat or directory-kind information is obtained through this symlink.
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it.each(["grep", "find"])("refuses %s rather than running an unconfined SDK external helper", async name => {
    await expect(invoke(name, { pattern: "data", path: root })).rejects.toThrow(/cannot fence its external helper/);
    expect(calls).toHaveLength(0);
  });
  it("does not use a foreign SDK cwd even with held paths", async () => {
    ctx = { ...ctx, cwd: join(root, "foreign") };
    await expect(invoke("read", { path: "file" })).rejects.toThrow(/inactive/);
    expect(calls).toHaveLength(0);
  });
});
