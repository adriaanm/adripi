import type { SandboxViolationEvent, SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";

export class ViolationTracker {
  private recent: SandboxViolationEvent[] = [];
  private total = 0;
  private unsubscribe?: () => void;

  start(store: SandboxViolationStore, onChange?: (total: number) => void): void {
    this.stop();
    this.total = store.getTotalCount();
    this.recent = store.getViolations(10);
    this.unsubscribe = store.subscribe((violations) => {
      this.recent = violations.slice(-10);
      this.total = store.getTotalCount();
      onChange?.(this.total);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  getTotal(): number {
    return this.total;
  }

  getRecent(): SandboxViolationEvent[] {
    return [...this.recent];
  }
}

export function removeSandboxViolationTags(text: string): string {
  if (!text.includes("<sandbox_violations>")) return text;
  return text.replace(/<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g, "").trimEnd();
}
