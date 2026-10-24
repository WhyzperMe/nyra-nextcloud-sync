import { describe, expect, it } from "vitest";
import { makeExplicitChoicePlan, makeSafeMergeRetryPlan } from "../src/planner/conflict-resolution";
import { fingerprintSyncPlan } from "../src/planner/planner";
import type { SyncPlan, SyncPlanItem } from "../src/planner/types";
import { assertPlanMatchesState } from "../src/execution/preconditions";
import { createEmptyState } from "../src/state/durable/model";

const conflict: SyncPlanItem = {
  entryId: "entry-a",
  displayPath: "Notes/A.md",
  baselinePath: "Notes/A.md",
  localPath: "Notes/A.md",
  remotePath: "Notes/A.md",
  classification: "both-change",
  disposition: "blocked",
  reasons: ["Both replicas contain different edits."],
  steps: [{ kind: "manual-resolution", sourcePath: "Notes/A.md", targetPath: null, destructive: false, requiresFreshRemoteEtag: false, description: "Review both versions." }],
  localChanged: true,
  remoteChanged: true,
  localPathChanged: false,
  remotePathChanged: false,
  remoteIdentityChanged: false,
  remoteContentKnown: true
};

async function planFor(item: SyncPlanItem): Promise<SyncPlan> {
  const plan: SyncPlan = {
    version: 2,
    createdAt: new Date(0).toISOString(),
    storeId: "store-a",
    stateGeneration: "7",
    walSequence: "7",
    walHash: "a".repeat(64),
    fingerprint: "",
    items: [item],
    summary: { total: 1, noop: 0, ready: 0, needsVerification: 0, mergeCandidates: 0, blocked: 1, destructiveSteps: 0, remoteVerifications: 0 }
  };
  plan.fingerprint = await fingerprintSyncPlan(plan);
  return plan;
}

describe("explicit conflict resolution plans", () => {
  it("turns a user-selected LOCAL version into an ETag-guarded upload and verified baseline", async () => {
    const plan = await makeExplicitChoicePlan(await planFor(conflict), "entry-a", "keep-local");
    expect(plan.summary.ready).toBe(1);
    expect(plan.items[0]?.steps.map((step) => step.kind)).toEqual(["upload-update", "establish-baseline"]);
    expect(plan.items[0]?.steps[0]?.requiresFreshRemoteEtag).toBe(true);
    expect(plan.items[0]?.steps[0]?.destructive).toBe(true);
    expect(plan.summary.destructiveSteps).toBe(1);
    expect(plan.items[0]?.reasons.at(-1)).toMatch(/explicitly chose LOCAL/i);
    expect(await fingerprintSyncPlan(plan)).toBe(plan.fingerprint);
  });

  it("turns a user-selected REMOTE version into a guarded atomic local update", async () => {
    const plan = await makeExplicitChoicePlan(await planFor(conflict), "entry-a", "keep-remote");
    expect(plan.items[0]?.steps.map((step) => step.kind)).toEqual(["download-update", "establish-baseline"]);
    expect(plan.items[0]?.steps[0]?.requiresFreshRemoteEtag).toBe(true);
  });

  it("supports an explicit one-record safe-merge retry without changing the normal auto-merge preference", async () => {
    const candidate: SyncPlanItem = {
      ...conflict,
      disposition: "merge-candidate",
      steps: [
        { kind: "merge-text", sourcePath: "Notes/A.md", targetPath: "Notes/A.md", destructive: false, requiresFreshRemoteEtag: true, description: "Merge verified text." },
        { kind: "establish-baseline", sourcePath: "Notes/A.md", targetPath: null, destructive: false, requiresFreshRemoteEtag: false, description: "Verify convergence." }
      ]
    };
    const plan = await makeSafeMergeRetryPlan(await planFor(candidate), "entry-a");
    expect(plan.items.length).toBe(1);
    expect(plan.items[0]?.disposition).toBe("merge-candidate");
    expect(plan.items[0]?.steps[0]?.kind).toBe("merge-text");
    expect(plan.summary.mergeCandidates).toBe(1);
    expect(plan.summary.blocked).toBe(0);
    expect(await fingerprintSyncPlan(plan)).toBe(plan.fingerprint);
    await expect(makeSafeMergeRetryPlan(await planFor(conflict), "entry-a")).rejects.toThrow(/not a current safe-merge candidate/i);
  });

  it("refuses rename/path conflicts and unverified remote content", async () => {
    const rename = await planFor({ ...conflict, classification: "rename-conflict" });
    await expect(makeExplicitChoicePlan(rename, "entry-a", "keep-local")).rejects.toThrow(/rename, deletion, or path identity/i);
    const unknown = await planFor({ ...conflict, remoteContentKnown: false });
    await expect(makeExplicitChoicePlan(unknown, "entry-a", "keep-remote")).rejects.toThrow(/hash-verified/i);
  });

  it("rejects a plan whose items were changed after fingerprinting", async () => {
    const plan = await planFor(conflict);
    const state = createEmptyState("store-a");
    state.generation = plan.stateGeneration;
    state.lastWalSequence = plan.walSequence;
    state.lastWalHash = plan.walHash;
    expect(await assertPlanMatchesState(plan, state)).toEqual(undefined);
    const tampered: SyncPlan = {
      ...plan,
      items: [{ ...conflict, reasons: ["unfingerprinted mutation"] }]
    };
    await expect(assertPlanMatchesState(tampered, state)).rejects.toThrow(/fingerprint/i);
  });
});
