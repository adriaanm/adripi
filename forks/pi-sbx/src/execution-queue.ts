/**
 * One bash execution at a time.
 *
 * The SRT manager is a process-wide singleton and a scoped command installs a
 * temporary runtime policy in it. Serializing executions is the first
 * containment measure: a second command must not start while the first has
 * widened the profile, and the baseline must be back before the next one begins.
 * Background descendants are not certified by this and stay an explicit
 * follow-up.
 */
export class ExecutionQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  run<T>(task: () => Promise<T>): Promise<T> {
    const start = () => {
      if (this.closed) throw new Error("Sandbox execution queue is closed");
      return task();
    };
    const result = this.tail.then(start, start);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Refuse queued/new work; wait for the active execution's finally/rollback. */
  close(): Promise<void> {
    this.closed = true;
    return this.tail;
  }
}
