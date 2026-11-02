import { describe, expect, it } from "vitest";
import { DeletionHold } from "../src/execution/deletion-hold";
import type { SyncPlan, SyncPlanItem, SyncPlanStep } from "../src/planner/types";

function plan(count: number): SyncPlan {
  const step: SyncPlanStep = { kind: "delete-remote", sourcePath: "x", targetPath: null, destructive: true, requiresFreshRemoteEtag: false, description: "delete" };
  return { items: Array.from({ length: count }, (_, index) => ({ entryId: `e${index}`, displayPath: `f${index}.md`, disposition: "ready", steps: [step] }) as unknown as SyncPlanItem) } as unknown as SyncPlan;
}

describe("combined file and folder deletion approval", () => {
  it("keeps the approval for the folder pass after the approved file deletions ran", () => {
    const hold = new DeletionHold();
    const files = plan(30);
    expect(hold.evaluate(files, 20, 1000).decision.held).toBe(true);
    expect(hold.approveFolderPlan([], ["a", "b", "c"], 1)).toBe(false); // folders held as well
    expect(hold.approve()).toBe(true);

    // Sync cycle: the approved file deletions run first, then the folder pass.
    expect(hold.evaluate(files, 20, 1000).decision.held).toBe(false);
    expect(hold.hasFileApproval(files)).toBe(true);
    hold.consumeFileApproval();
    expect(hold.hasFileApproval(files)).toBe(false); // the file approval is spent
    expect(hold.approveFolderPlan([], ["c", "b", "a"], 1)).toBe(true); // the folder approval was not
    hold.consumeApproval();
    expect(hold.summary()).toBeNull();
  });

  it("does not let a spent file approval authorize a different folder set", () => {
    const hold = new DeletionHold();
    hold.evaluate(plan(30), 20, 1000);
    hold.approveFolderPlan([], ["a", "b"], 1);
    hold.approve();
    hold.consumeFileApproval();
    expect(hold.approveFolderPlan([], ["a", "z"], 1)).toBe(false);
  });

  it("forgets the approval completely when no folders were held", () => {
    const hold = new DeletionHold();
    hold.evaluate(plan(30), 20, 1000);
    hold.approve();
    hold.consumeFileApproval();
    expect(hold.hasApproval()).toBe(false);
    expect(hold.summary()).toBeNull();
    expect(hold.evaluate(plan(30), 20, 1000).decision.held).toBe(true);
  });
});
