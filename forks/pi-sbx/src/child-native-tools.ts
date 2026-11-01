import { constants } from "node:fs";
import { access, readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { pathGrantFeasibility, type PathAction, type PathAuthorization } from "./path-authorizer.ts";
import { canonicalizeTarget, canRead, canTraverse, resolveReadTarget, resolveTarget, type FilePolicy } from "./path-policy.ts";

/** Host-code dependency, not a second broker or an approval cache. The bound
 * consumer supplies the same lease/current-parent path route for each call. */
export interface ChildNativeAuthority {
  readonly signal: AbortSignal;
  assertActive(ctx: ExtensionContext): void;
  filePolicy(ctx: ExtensionContext): FilePolicy;
  authorizePath(action: PathAction, ctx: ExtensionContext, signal: AbortSignal): Promise<PathAuthorization>;
}

/** Install genuine SDK builders/schemas with operation-local filesystem fences.
 * These execute AFTER all SDK tool_call handlers, including async Guardian
 * review, and recheck pins/cancellation/aliases at every actual operation. No
 * tool_call ordering or a synthetic sandbox acknowledgment is sufficient. */
export function registerChildNativeTools(pi: ExtensionAPI, authority: ChildNativeAuthority): void {
  type Frame = Awaited<ReturnType<typeof admit>>;
  const nativePolicy = (ctx: ExtensionContext): FilePolicy => {
    const policy = authority.filePolicy(ctx);
    // The SDK's Node host is outside the command jail. File tools must not
    // expose its environment/memory/descriptors or re-open the disabled TTY/
    // device namespace through a pathname. These only narrow native IO; the
    // existing SRT still owns command-process namespaces and normal /dev/null.
    const hostNamespaces = ["/proc", "/sys", "/dev"];
    return { ...policy, mandatoryDenyRead: [...policy.mandatoryDenyRead, ...hostNamespaces],
      mandatoryDenyWrite: [...policy.mandatoryDenyWrite, ...hostNamespaces] };
  };
  async function admit(kind: "read" | "edit" | "write" | "ls", raw: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<{
    signal: AbortSignal; target: string; check(): void; path(actual: string): string; parent(actual: string): string;
  }> {
    const signals = [authority.signal, ...(signal ? [signal] : []), ...(ctx.signal ? [ctx.signal] : [])];
    const combined = signals.length > 1 ? AbortSignal.any(signals) : authority.signal;
    authority.assertActive(ctx);
    if (combined.aborted) throw new Error("Child native operation was cancelled");
    const resolve = kind === "read" ? resolveReadTarget : canonicalizeTarget;
    const target = resolve(raw, ctx.cwd);
    const policy = nativePolicy(ctx);
    const check = () => {
      authority.assertActive(ctx);
      if (combined.aborted) throw new Error("Child native operation was cancelled");
      if (resolve(raw, ctx.cwd) !== target) throw new Error("Child native target changed during the operation");
    };
    if (kind === "ls" && !canTraverse(target, ctx.cwd, policy)) throw new Error("Child native traversal is excluded by baseline policy; recursive traversal is not grantable");
    const surfaces = kind === "edit" ? ["read", "write"] as const : [kind === "write" ? "write" : "read"] as const;
    const aliases = [resolveTarget(raw, ctx.cwd)];
    const actions: PathAction[] = surfaces.map(surface => ({ surface, target, aliases,
      reason: `Admit this one delegated native ${kind} operation at its exact target`, origin: "tool" }));
    // In particular, an impossible write cannot spend a read admission first.
    for (const action of actions) {
      const possible = pathGrantFeasibility(action, ctx.cwd, policy);
      if (!possible.ok) throw new Error(possible.reason);
    }
    for (const action of actions) {
      const decision = await authority.authorizePath(action, ctx, combined);
      check();
      if (decision.kind !== "allow") throw new Error(`Child native ${action.surface} refused: ${decision.reason}`);
      if (kind === "ls" && decision.granted) throw new Error("Child native traversal cannot borrow an exact-file grant");
    }
    return { signal: combined, target, check, parent(actual) {
      check();
      if (resolveTarget(actual, ctx.cwd) !== dirname(resolveTarget(raw, ctx.cwd))) throw new Error("SDK write backend addressed an unadmitted parent directory");
      return dirname(target);
    }, path(actual) {
      check();
      if (resolve(actual, ctx.cwd) !== target) throw new Error("SDK native backend addressed a different target than the admitted operation");
      // The backend may not reinterpret the original alias after admission.
      return target;
    } };
  }
  async function io<T>(frame: Frame, operation: () => Promise<T>): Promise<T> {
    frame.check();
    const result = await operation();
    frame.check();
    return result;
  }
  function install<S extends TSchema, D>(definition: ToolDefinition<S, D>, execute: ToolDefinition<S, D>["execute"]): void {
    pi.registerTool({ ...definition, execute });
  }

  install(createReadToolDefinition(process.cwd()), async (id, input, signal, update, ctx) => {
    const frame = await admit("read", input.path, ctx, signal);
    const tool = createReadToolDefinition(ctx.cwd, { operations: {
      access: path => io(frame, () => access(frame.path(path), constants.R_OK)),
      readFile: path => io(frame, () => readFile(frame.path(path), { signal: frame.signal })),
      detectImageMimeType: path => io(frame, () => detectSupportedImageMimeTypeFromFile(frame.path(path))),
    } });
    return io(frame, () => tool.execute(id, input, frame.signal, update, ctx));
  });
  // SDK edit's renderCall prefetches a disk preview outside execute/operations.
  // A delegated child must not gain that speculative read. Default SDK argument
  // rendering is sufficient; result diffs still come from the fenced execution.
  install({ ...createEditToolDefinition(process.cwd()), renderCall: undefined }, async (id, input, signal, update, ctx) => {
    const frame = await admit("edit", input.path, ctx, signal);
    const tool = createEditToolDefinition(ctx.cwd, { operations: {
      access: path => io(frame, () => access(frame.path(path), constants.R_OK | constants.W_OK)),
      readFile: path => io(frame, () => readFile(frame.path(path), { signal: frame.signal })),
      writeFile: (path, content) => io(frame, () => writeFile(frame.path(path), content, { encoding: "utf8", signal: frame.signal })),
    } });
    return io(frame, () => tool.execute(id, input, frame.signal, update, ctx));
  });
  install(createWriteToolDefinition(process.cwd()), async (id, input, signal, update, ctx) => {
    const frame = await admit("write", input.path, ctx, signal);
    const tool = createWriteToolDefinition(ctx.cwd, { operations: {
      mkdir: path => io(frame, async () => {
        await mkdir(frame.parent(path), { recursive: true });
      }),
      writeFile: (path, content) => io(frame, () => writeFile(frame.path(path), content, { encoding: "utf8", signal: frame.signal })),
    } });
    return io(frame, () => tool.execute(id, input, frame.signal, update, ctx));
  });
  install(createLsToolDefinition(process.cwd()), async (id, input, signal, update, ctx) => {
    const frame = await admit("ls", input.path ?? ctx.cwd, ctx, signal);
    const entryPath = (actual: string) => {
      frame.check();
      const canonical = canonicalizeTarget(actual, ctx.cwd);
      const sub = relative(frame.target, canonical);
      if (isAbsolute(sub) || sub === ".." || sub.startsWith("../") || !canRead(canonical, ctx.cwd, nativePolicy(ctx))) {
        throw new Error("Child ls metadata target leaves its admitted readable tree");
      }
      return canonical;
    };
    const tool = createLsToolDefinition(ctx.cwd, { operations: {
      exists: path => io(frame, async () => { try { await access(frame.path(path)); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error;
      } }),
      stat: path => io(frame, () => stat(entryPath(path))),
      readdir: path => io(frame, () => readdir(frame.path(path))),
    } });
    return io(frame, () => tool.execute(id, input, frame.signal, update, ctx));
  });

  // These SDK versions spawn rg/fd without a subprocess/env operation hook. An
  // exact semantic allow cannot jail a PATH/config-selected helper in Node's
  // host process. Preserve native schemas, but explicitly refuse rather than
  // invent a replacement search/shell engine or silently run it outside SRT.
  for (const tool of [createGrepToolDefinition(process.cwd()), createFindToolDefinition(process.cwd())]) {
    pi.registerTool({ ...tool, async execute(_id, _input, _signal, _update, ctx) {
      authority.assertActive(ctx);
      throw new Error(`Delegated native ${tool.name} is unavailable: this SDK cannot fence its external helper; no operation ran`);
    } });
  }
}
