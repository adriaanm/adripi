import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { expandLinuxWriteGlobs } from "./linux-globs.ts";
import { RuntimeSandboxManager } from "./manager.ts";

const CAPTURE_LIMIT = 64 * 1024;
// macOS sandbox violations arrive from an async log monitor; give late
// events a short window to land before annotating the model-visible output.
const VIOLATION_SETTLE_MS = 150;

function settleViolations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, VIOLATION_SETTLE_MS));
}

async function annotateViolations(
  commandId: string,
  output: string,
  onData: (data: Buffer) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (emitViolationAnnotation(commandId, output, onData)) return;
  if (process.platform !== "darwin" || signal?.aborted) return;
  await settleViolations();
  emitViolationAnnotation(commandId, output, onData);
}

export function createSandboxedBashOperations(options: {
  shellPath?: string;
} = {}): BashOperations {
  const local = createLocalBashOperations({ shellPath: options.shellPath });
  return {
    async exec(command, cwd, execOptions) {
      const commandId = randomUUID();
      let captured = "";
      const onData = (data: Buffer) => {
        captured = (captured + data.toString("utf8")).slice(-CAPTURE_LIMIT);
        execOptions.onData(data);
      };
      try {
        const activeConfig = RuntimeSandboxManager.getConfig?.();
        const writeGlobOverride = process.platform === "linux" && activeConfig
          ? expandLinuxWriteGlobs(activeConfig, cwd)
          : undefined;
        const wrapped = await RuntimeSandboxManager.wrapWithSandbox(
          command,
          undefined,
          writeGlobOverride,
          execOptions.signal,
          { commandId, commandText: command },
        );
        const result = await local.exec(wrapped, cwd, { ...execOptions, onData });
        await annotateViolations(commandId, captured, execOptions.onData, execOptions.signal);
        return result;
      } catch (error) {
        await annotateViolations(commandId, captured, execOptions.onData, execOptions.signal);
        throw error;
      } finally {
        RuntimeSandboxManager.cleanupAfterCommand();
      }
    },
  };
}

function emitViolationAnnotation(commandId: string, output: string, onData: (data: Buffer) => void): boolean {
  const annotated = RuntimeSandboxManager.annotateStderrWithSandboxFailures(commandId, output);
  if (!annotated.startsWith(output) || annotated.length <= output.length) return false;
  onData(Buffer.from(annotated.slice(output.length)));
  return true;
}
