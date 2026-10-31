import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

const failures = vi.hoisted(() => ({ write: false, close: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (failures.write) throw new Error("ENOSPC: fixture full disk");
      return fs.writeSync(...args);
    },
    closeSync: (fd: number) => { fs.closeSync(fd); if (failures.close) throw new Error("fixture close failed"); },
  };
});
import { OutputCapture, validateOutputFile } from "../src/output-capture.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pi-sbx-output-")); failures.write = failures.close = false; });
afterEach(() => { failures.write = failures.close = false; rmSync(root, { recursive: true, force: true }); });
const result = { content: [{ type: "text" as const, text: "preview" }], details: { original: true } };
function backend(run: BashOperations["exec"]): BashOperations { return { exec: run }; }

describe("one-action output capture backend", () => {
  it("does not create a file until operations exec, and preserves native result details", async () => {
    const capture = new OutputCapture("new.log", root);
    const value = await capture.run(async () => result);
    expect(existsSync(join(root, "new.log"))).toBe(false);
    expect(value.details).toMatchObject({ original: true, outputCapture: { created: false, status: "not_started" } });
  });

  it("captures raw buffers without decoding UTF-8 and leaves command/env/options unchanged", async () => {
    const capture = new OutputCapture("bytes.log", root);
    const bytes = Buffer.from([0, 255, 0xe2, 0x82, 0xac]);
    const env = { FIXTURE: "value" };
    await capture.run(async () => {
      await capture.wrap(backend(async (command, cwd, options) => {
        expect(command).toBe("exact command"); expect(cwd).toBe(root);
        expect(options.env).toBe(env); expect(options.timeout).toBe(7);
        options.onData(bytes.subarray(0, 3)); options.onData(bytes.subarray(3));
        return { exitCode: 0 };
      })).exec("exact command", root, { onData: () => {}, timeout: 7, env });
      return result;
    });
    expect(readFileSync(join(root, "bytes.log"))).toEqual(bytes);
    expect(capture.snapshot()).toMatchObject({ bytes: 5, complete: true, exitCode: 0 });
  });

  it("keeps the actual SDK preview bounded while storing full output", async () => {
    const capture = new OutputCapture("large.log", root);
    const bytes = Buffer.alloc(150_000, "q");
    const tool = createBashToolDefinition(root, { exposeSessionEnvironment: false,
      operations: capture.wrap(backend(async (_command, _cwd, options) => {
        options.onData(bytes); return { exitCode: 0 };
      })),
    });
    const value = await capture.run(() => tool.execute("large", { command: "unchanged" }, undefined, undefined, undefined!));
    expect(readFileSync(join(root, "large.log"))).toEqual(bytes);
    expect(JSON.stringify(value.content).length).toBeLessThan(60_000);
    expect(value.details).toMatchObject({ truncation: { truncated: true }, outputCapture: { bytes: bytes.length, complete: true } });
  });

  it("refuses existing symlinks, dangling symlinks and hardlinks without executing", async () => {
    writeFileSync(join(root, "original"), "keep");
    symlinkSync(join(root, "original"), join(root, "symlink"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    linkSync(join(root, "original"), join(root, "hardlink"));
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    for (const path of ["original", "symlink", "dangling", "hardlink"]) {
      const capture = new OutputCapture(path, root);
      await expect(capture.run(async () => {
        await capture.wrap(backend(execute)).exec("unchanged", root, { onData: () => {} }); return result;
      })).rejects.toThrow("EEXIST");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "original"), "utf8")).toBe("keep");
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  it("does not implicitly create missing parent directories", async () => {
    const capture = new OutputCapture("missing/log", root);
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    await expect(capture.run(async () => {
      await capture.wrap(backend(execute)).exec("unchanged", root, { onData: () => {} }); return result;
    })).rejects.toThrow("ENOENT");
    expect(execute).not.toHaveBeenCalled(); expect(existsSync(join(root, "missing"))).toBe(false);
  });

  it("refuses pre-start cancellation without creating or executing", async () => {
    const capture = new OutputCapture("cancelled.log", root);
    const controller = new AbortController(); controller.abort();
    const execute = vi.fn(async () => ({ exitCode: 0 }));
    await expect(capture.run(async () => {
      await capture.wrap(backend(execute)).exec("unchanged", root, { onData: () => {}, signal: controller.signal }); return result;
    })).rejects.toThrow('"status":"cancelled"');
    expect(execute).not.toHaveBeenCalled(); expect(existsSync(join(root, "cancelled.log"))).toBe(false);
  });

  it("aborts the existing backend on disk failure without throwing from onData or reporting success", async () => {
    const capture = new OutputCapture("partial.log", root);
    await expect(capture.run(async () => {
      await capture.wrap(backend(async (_command, _cwd, options) => {
        options.onData(Buffer.from("kept")); failures.write = true;
        expect(() => options.onData(Buffer.from("lost"))).not.toThrow();
        expect(options.signal?.aborted).toBe(true);
        return { exitCode: 0 }; // Even a backend ignoring cancellation cannot turn this green.
      })).exec("unchanged", root, { onData: () => {} }); return result;
    })).rejects.toThrow("ENOSPC");
    expect(readFileSync(join(root, "partial.log"), "utf8")).toBe("kept");
    expect(capture.snapshot()).toMatchObject({ bytes: 4, complete: false, status: "failed" });
  });

  it("reports close failures and a moved/replaced artifact rather than a valid complete log", async () => {
    for (const mode of ["close", "moved", "replaced"]) {
      const capture = new OutputCapture(`${mode}.log`, root);
      await expect(capture.run(async () => {
        await capture.wrap(backend(async (_command, _cwd, options) => {
          options.onData(Buffer.from("saved"));
          if (mode === "close") failures.close = true;
          else {
            renameSync(join(root, `${mode}.log`), join(root, `${mode}.old`));
            if (mode === "replaced") writeFileSync(join(root, `${mode}.log`), "other");
          }
          return { exitCode: 0 };
        })).exec("unchanged", root, { onData: () => {} }); return result;
      })).rejects.toThrow("Output capture failed");
      failures.close = false;
      expect(capture.snapshot()).toMatchObject({ complete: false, status: "failed" });
    }
  });

  it("preserves structured SDK error flags as well as older SDK throw semantics", async () => {
    const capture = new OutputCapture("native-error.log", root);
    const value = await capture.run(async () => {
      await capture.wrap(backend(async (_command, _cwd, options) => {
        options.onData(Buffer.from("failed")); return { exitCode: 3 };
      })).exec("unchanged", root, { onData: () => {} });
      return { ...result, isError: true };
    });
    expect(value).toMatchObject({ isError: true, details: { outputCapture: { exitCode: 3, complete: true } } });
  });

  it("does not report a signal-only unknown exit as normal completion", async () => {
    const capture = new OutputCapture("signal.log", root);
    await capture.run(async () => {
      await capture.wrap(backend(async () => ({ exitCode: null }))).exec("unchanged", root, { onData: () => {} }); return result;
    });
    expect(capture.snapshot()).toMatchObject({ exitCode: null, status: "interrupted", complete: false });
  });

  it("validates path input and does not accept control characters or oversized paths", () => {
    for (const input of [null, 0, {}, "", " ", "a\rlog", "a\0log", "q".repeat(4097)]) expect(() => validateOutputFile(input)).toThrow("output_file");
    expect(validateOutputFile("a file.log")).toBe("a file.log");
  });
});
