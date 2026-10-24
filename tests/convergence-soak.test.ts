import { describe, expect, it } from "vitest";
import { runConvergenceSoak } from "./helpers/convergence-soak";

describe("seeded convergence soak", () => {
  it.each([0x12c0ffee, 0x13c0ffee, 0x9e3779b9])("plans deterministically and merges safely for seed %i", async (seed) => {
    const summary = await runConvergenceSoak(seed, 400);
    expect(summary.rounds).toBe(400);
    expect(summary.deterministicPlans).toBe(400);
  });
});
