import { describe, expect, it, vi } from "vitest";
import { ExecutionQueue } from "../src/execution-queue.ts";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("execution queue", () => {
  it("runs tasks one at a time in submission order", async () => {
    const queue = new ExecutionQueue();
    const events: string[] = [];
    const first = deferred();
    const firstRun = queue.run(async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
      return "first";
    });
    const secondRun = queue.run(async () => {
      events.push("second:start");
      return "second";
    });

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    first.resolve();
    await expect(firstRun).resolves.toBe("first");
    await expect(secondRun).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("closes admission and drains active rollback before shutdown", async () => {
    const queue = new ExecutionQueue();
    const held = deferred();
    const started = deferred();
    let restored = false;
    const active = queue.run(async () => {
      started.resolve();
      try { await held.promise; } finally { restored = true; }
    });
    await started.promise;
    const next = vi.fn(async () => undefined);
    const pending = queue.run(next);
    const rejected = expect(pending).rejects.toThrow("queue is closed");
    let closed = false;
    const closing = queue.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    held.resolve();
    await active;
    await rejected;
    await closing;
    expect(restored).toBe(true);
    expect(next).not.toHaveBeenCalled();
    await expect(queue.run(next)).rejects.toThrow("queue is closed");
  });

  it("keeps the queue usable after a task fails", async () => {
    const queue = new ExecutionQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
  });
});
