import { describe, expect, it } from "vitest";
import { runStateMachine } from "./helpers/state-machine";

describe("generated durable-state machine", () => {
  it.each([0x14c0ffee, 0x9e3779b9, 0x5f3759df])("keeps every invariant across restarts, conflicts and failures for seed %i", async (seed) => {
    const summary = await runStateMachine(seed, 3000);
    expect(summary.transitions).toBe(3000);
    expect(summary.durableIntegrityChecks).toBeGreaterThan(0);
  }, 60_000);
});
