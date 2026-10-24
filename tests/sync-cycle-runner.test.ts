import { describe, expect, it } from "vitest";
import type { ExecutionReport } from "../src/execution/types";
import type { SyncPlan } from "../src/planner/types";
import { NyraError } from "../src/core/errors";
import { SyncCycleRunner, type SyncCyclePort } from "../src/sync/cycle-runner";

const noopPlan: SyncPlan = {
  version: 2,
  createdAt: new Date(0).toISOString(),
  storeId: "store",
  stateGeneration: "1",
  walSequence: "1",
  walHash: null,
  fingerprint: "f".repeat(64),
  items: [],
  summary: { total: 0, noop: 0, ready: 0, needsVerification: 0, mergeCandidates: 0, blocked: 0, destructiveSteps: 0, remoteVerifications: 0 }
};

const report: ExecutionReport = {
  planFingerprint: noopPlan.fingerprint,
  startedAt: new Date(0).toISOString(),
  finishedAt: new Date(1).toISOString(),
  completed: 0,
  skipped: 0,
  blocked: 0,
  failed: 0,
  bytesProcessed: 0,
  chunkedTransfers: 0,
  resumedTransfers: 0,
  rangedDownloads: 0,
  mergedFiles: 0,
  mergeConflicts: 0,
  results: []
};

function port(overrides: Partial<SyncCyclePort> = {}): SyncCyclePort {
  return {
    localFactsComplete: () => true,
    remoteFactsComplete: () => true,
    lastFullLocalScanAt: () => 10_000,
    now: () => 11_000,
    flushLocalHints: async () => undefined,
    waitForLocalInventory: async () => undefined,
    scanLocalFull: async () => true,
    scanRemoteFull: async () => true,
    buildPlan: async () => noopPlan,
    autoMergeEnabled: () => true,
    applyPlan: async () => report,
    syncFolders: async () => 0,
    ...overrides
  };
}

describe("Sync cycle runner", () => {
  it("does not rehash a healthy idle vault on every remote poll", async () => {
    const calls: string[] = [];
    await new SyncCycleRunner(port({
      flushLocalHints: async () => { calls.push("flush"); },
      waitForLocalInventory: async () => { calls.push("idle"); },
      scanLocalFull: async () => { calls.push("full-local"); return true; },
      scanRemoteFull: async () => { calls.push("full-remote"); return true; }
    })).run("remote-poll", false);
    expect(calls).toEqual(["flush", "idle", "full-remote"]);
  });

  for (const trigger of ["startup", "foreground-resume", "manual"] as const) it(`requires a full local scan on ${trigger}`, async () => {
    let full = 0;
    await new SyncCycleRunner(port({ scanLocalFull: async () => { full++; return true; } })).run(trigger, false);
    expect(full).toBe(1);
  });

  it("retains the full-scan fence for deletion and periodic verification", async () => {
    for (const allowDeletes of [false, true]) {
      let full = 0;
      await new SyncCycleRunner(port({
        now: () => allowDeletes ? 11_000 : 310_000,
        scanLocalFull: async () => { full++; return true; }
      })).run("remote-poll", allowDeletes);
      expect(full).toBe(1);
    }
  });

  it("uses queued targeted observations for a quiet local edit without a redundant full hash scan", async () => {
    const calls: string[] = [];
    const runner = new SyncCycleRunner(port({
      flushLocalHints: async () => { calls.push("flush"); },
      waitForLocalInventory: async () => { calls.push("idle"); },
      scanLocalFull: async () => { calls.push("full-local"); return true; },
      scanRemoteFull: async () => { calls.push("full-remote"); return true; },
      buildPlan: async () => { calls.push("plan"); return noopPlan; }
    }));
    const result = await runner.run("local-quiet", false);
    expect(calls).toEqual(["flush", "idle", "full-remote", "plan"]);
    expect(result.executed).toBe(false);
  });

  it("requires complete local and remote facts before a plan or any write", async () => {
    let plans = 0;
    let applies = 0;
    const runner = new SyncCycleRunner(port({
      localFactsComplete: () => false,
      scanLocalFull: async () => false,
      buildPlan: async () => { plans += 1; return noopPlan; },
      applyPlan: async () => { applies += 1; return report; }
    }));
    await expect(runner.run("local-quiet", false)).rejects.toThrow(/Local inventory is incomplete/i);
    expect(plans).toBe(0);
    expect(applies).toBe(0);
  });

  it("does not build or execute a plan from an incomplete remote inventory", async () => {
    let plans = 0;
    const runner = new SyncCycleRunner(port({
      scanRemoteFull: async () => false,
      remoteFactsComplete: () => false,
      buildPlan: async () => { plans += 1; return noopPlan; }
    }));
    await expect(runner.run("local-quiet", false)).rejects.toThrow(/Remote inventory is incomplete/i);
    expect(plans).toBe(0);
  });

  it("executes a safe merge candidate automatically and leaves it for review when disabled", async () => {
    const mergePlan: SyncPlan = {
      ...noopPlan,
      items: [{
        entryId: "merge-entry", displayPath: "Notes/Merge.md", baselinePath: "Notes/Merge.md",
        localPath: "Notes/Merge.md", remotePath: "Notes/Merge.md", classification: "both-change",
        disposition: "merge-candidate", reasons: [],
        steps: [{ kind: "merge-text", sourcePath: "Notes/Merge.md", targetPath: "Notes/Merge.md", destructive: false, requiresFreshRemoteEtag: true, description: "Verified three-way merge." }],
        localChanged: true, remoteChanged: true, localPathChanged: false, remotePathChanged: false,
        remoteIdentityChanged: false, remoteContentKnown: true
      }],
      summary: { total: 1, noop: 0, ready: 0, needsVerification: 0, mergeCandidates: 1, blocked: 0, destructiveSteps: 0, remoteVerifications: 0 }
    };
    let applies = 0;
    const mergedReport: ExecutionReport = { ...report, completed: 1, mergedFiles: 1 };
    const automatic = await new SyncCycleRunner(port({
      buildPlan: async () => mergePlan,
      applyPlan: async () => { applies += 1; return mergedReport; }
    })).run("local-quiet", false);
    expect(automatic.executed).toBe(true);
    expect(automatic.completedSteps).toBe(1);
    expect(applies).toBe(1);

    const manualReview = await new SyncCycleRunner(port({
      buildPlan: async () => mergePlan,
      autoMergeEnabled: () => false,
      applyPlan: async () => { applies += 1; return mergedReport; }
    })).run("local-quiet", false);
    expect(manualReview.reviewItems).toBe(1);
    expect(manualReview.executed).toBe(false);
    expect(applies).toBe(1);

    const blockedMerge = await new SyncCycleRunner(port({
      buildPlan: async () => mergePlan,
      applyPlan: async () => ({ ...report, blocked: 1, mergeConflicts: 1 })
    })).run("local-quiet", false);
    expect(blockedMerge.reviewItems).toBe(1);
    expect(blockedMerge.blockedSteps).toBe(1);
    expect(blockedMerge.executed).toBe(false);
  });
});

describe("sync cycle runner replanning", () => {
  it("re-inventories and replans after an expected precondition change", async () => {
    let scans = 0;
    let applies = 0;
    const result = await new SyncCycleRunner(port({
      scanRemoteFull: async () => { scans += 1; return true; },
      buildPlan: async () => ({ ...noopPlan, summary: { ...noopPlan.summary, total: 1, ready: 1 } }),
      applyPlan: async () => {
        applies += 1;
        if (applies === 1) throw new NyraError("sync-precondition-changed", "ETag changed.");
        return { ...report, completed: 1 };
      }
    }), [0, 0]).run("manual", false);
    expect(scans).toBe(2);
    expect(result.executed).toBe(true);
  });

  it("gives up after the bounded number of replans and never retries unsafe failures", async () => {
    let applies = 0;
    const always = port({
      buildPlan: async () => ({ ...noopPlan, summary: { ...noopPlan.summary, total: 1, ready: 1 } }),
      applyPlan: async () => { applies += 1; throw new NyraError("sync-precondition-changed", "ETag changed."); }
    });
    await expect(new SyncCycleRunner(always, [0, 0]).run("manual", false)).rejects.toThrow("ETag changed");
    expect(applies).toBe(3);

    let unsafe = 0;
    const unreliable = port({
      buildPlan: async () => ({ ...noopPlan, summary: { ...noopPlan.summary, total: 1, ready: 1 } }),
      applyPlan: async () => { unsafe += 1; throw new NyraError("remote-precondition-unreliable", "bad server"); }
    });
    await expect(new SyncCycleRunner(unreliable, [0, 0]).run("manual", false)).rejects.toThrow("bad server");
    expect(unsafe).toBe(1);
  });
});
