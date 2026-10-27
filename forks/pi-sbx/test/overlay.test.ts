import { describe, expect, it, vi } from "vitest";
import { applyAfterPersist } from "../src/overlay.ts";

describe("session overlay transactions", () => {
  it("applies an approval only after persistence succeeds", async () => {
    const values = new Set<string>();
    const persist = vi.fn(async () => undefined);
    await applyAfterPersist(persist, () => values.add("approved"));
    expect(persist).toHaveBeenCalledOnce();
    expect(values.has("approved")).toBe(true);
  });

  it("leaves the overlay unchanged when persistence fails", async () => {
    const values = new Set<string>();
    await expect(applyAfterPersist(
      async () => { throw new Error("disk full"); },
      () => values.add("unexpected"),
    )).rejects.toThrow("disk full");
    expect(values.size).toBe(0);
  });
});
