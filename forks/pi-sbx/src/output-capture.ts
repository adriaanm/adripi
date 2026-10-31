import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from "node:fs";
import type { AgentToolResult, BashOperations } from "@earendil-works/pi-coding-agent";
import { canonicalizeTarget, resolveTarget } from "./path-policy.ts";

export function validateOutputFile(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("output_file must be a nonempty path of at most 4096 UTF-8 bytes without control characters");
  }
  return value;
}

export interface CaptureStatus {
  path: string;
  created: boolean;
  bytes: number;
  status: "not_started" | "running" | "exited" | "interrupted" | "cancelled" | "timed_out" | "failed";
  exitCode: number | null;
  complete: boolean;
  error?: string;
}

/** One already-authorized destination; never a permission store or shell wrapper.
 * Open only at the operations seam, after execution admission. Exclusive creation
 * prevents overwrite, hardlink and final-component symlink writes. Re-resolution
 * catches between-action alias drift, not hostile same-user filesystem races.
 */
export class OutputCapture {
  readonly target: string;
  readonly alias: string;
  private fd: number | undefined;
  private used = false;
  private readonly stop = new AbortController();
  private readonly state: CaptureStatus;
  private readonly cwd: string;

  constructor(path: string, cwd: string) {
    validateOutputFile(path);
    this.cwd = cwd;
    this.alias = resolveTarget(path, cwd);
    this.target = canonicalizeTarget(path, cwd);
    this.state = { path: this.target, created: false, bytes: 0, status: "not_started", exitCode: null, complete: false };
  }

  private start(signal?: AbortSignal): void {
    if (this.used) throw new Error("output capture cannot be reused for another execution");
    this.used = true;
    if (signal?.aborted) throw new Error("aborted");
    if (canonicalizeTarget(this.alias, this.cwd) !== this.target) throw new Error("output_file changed after authorization");
    // Refuse even a dangling final-component symlink before opening the
    // canonical target. No mkdir, append or overwrite; parent must exist.
    if (lstatSync(this.alias, { throwIfNoEntry: false })) throw new Error("EEXIST: output_file already exists; overwrite and append are not supported");
    this.fd = openSync(this.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.state.created = true;
    if (!fstatSync(this.fd).isFile() || canonicalizeTarget(this.alias, this.cwd) !== this.target) {
      throw new Error("output_file is not a stable regular file after opening");
    }
    this.state.status = "running";
  }

  private fail(error: unknown): void {
    this.state.error ??= error instanceof Error ? error.message : String(error);
    this.state.complete = false;
    this.state.status = "failed";
    this.stop.abort();
  }

  private write(data: Buffer): void {
    if (this.state.error || this.fd === undefined) return;
    try {
      // Synchronous regular-file writes avoid an unbounded stream queue: the
      // SDK's onData interface has no asynchronous backpressure contract.
      let offset = 0;
      while (offset < data.length) {
        const count = writeSync(this.fd, data, offset, Math.min(data.length - offset, 64 * 1024));
        if (count <= 0) throw new Error("output_file write made no progress");
        offset += count;
        this.state.bytes += count;
      }
    } catch (error) { this.fail(error); }
  }

  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) {
      try {
        const opened = fstatSync(fd);
        const named = lstatSync(this.target);
        if (!named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino || canonicalizeTarget(this.alias, this.cwd) !== this.target) {
          throw new Error("output_file was moved, replaced or retargeted during execution");
        }
      } catch (error) { this.fail(error); }
      finally { try { closeSync(fd); } catch (error) { this.fail(error); } }
    }
  }

  wrap(operations: BashOperations): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        try {
          this.start(options.signal);
          const result = await operations.exec(command, cwd, {
            ...options,
            signal: options.signal ? AbortSignal.any([options.signal, this.stop.signal]) : this.stop.signal,
            onData: data => { this.write(data); options.onData(data); },
          });
          this.state.exitCode = result.exitCode;
          if (!this.state.error) {
            this.state.status = result.exitCode === null ? "interrupted" : "exited";
            this.state.complete = result.exitCode !== null;
          }
          return result;
        } catch (error) {
          if (!this.state.error) {
            this.state.status = options.signal?.aborted ? "cancelled"
              : error instanceof Error && error.message.startsWith("timeout:") ? "timed_out" : "failed";
          }
          throw error;
        } finally { this.close(); }
      },
    };
  }

  snapshot(): CaptureStatus { return { ...this.state }; }

  private notice(): string { return `\n\n[Output capture: ${JSON.stringify(this.snapshot())}]`; }

  async run(execute: () => Promise<AgentToolResult<unknown>>): Promise<AgentToolResult<unknown>> {
    try {
      const result = await execute();
      this.close();
      if (this.state.error) throw new Error(`Output capture failed: ${this.state.error}`);
      const previous = result.details;
      return {
        ...result,
        content: [...result.content, { type: "text", text: this.notice().trimStart() }],
        details: {
          ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : { upstreamDetails: previous }),
          outputCapture: this.snapshot(),
        },
      };
    } catch (error) {
      this.close();
      const reason = error instanceof Error ? error.message : String(error);
      // Preserve SDK throw/error semantics on every supported host, including
      // old hosts that cannot persist structured details on thrown failures.
      throw new Error(`${reason}${this.state.error ? `\nOutput capture failed: ${this.state.error}` : ""}${this.notice()}`, { cause: error });
    }
  }
}
