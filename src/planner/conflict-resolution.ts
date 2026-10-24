import type { SyncPlan, SyncPlanItem, SyncPlanStep } from "./types";
import { fingerprintSyncPlan } from "./planner";

export type ConflictChoice = "keep-local" | "keep-remote";

/** Build a one-record retry that explicitly opts into the safe merge engine. */
export async function makeSafeMergeRetryPlan(plan: SyncPlan, entryId: string): Promise<SyncPlan> {
  const item = plan.items.find((candidate) => candidate.entryId === entryId);
  if (!item || item.disposition !== "merge-candidate" || item.classification !== "both-change" || !item.steps.some((step) => step.kind === "merge-text")) {
    throw new Error("This item is not a current safe-merge candidate; rebuild the sync plan.");
  }
  const items = [item];
  const summary = {
    total: 1,
    noop: 0,
    ready: 0,
    needsVerification: 0,
    mergeCandidates: 1,
    blocked: 0,
    destructiveSteps: item.steps.filter((step) => step.destructive).length,
    remoteVerifications: item.steps.filter((step) => step.kind === "verify-remote-content").length
  };
  const selectedPlan: SyncPlan = { ...plan, items, summary, fingerprint: "" };
  selectedPlan.fingerprint = await fingerprintSyncPlan(selectedPlan);
  return selectedPlan;
}

/** Build a fresh, single-record plan after both source versions were copied. */
export async function makeExplicitChoicePlan(
  plan: SyncPlan,
  entryId: string,
  choice: ConflictChoice
): Promise<SyncPlan> {
  const item = plan.items.find((candidate) => candidate.entryId === entryId);
  assertConflictChoiceEligible(item);
  if (!item) throw new Error("This conflict is no longer current; rebuild the sync plan.");

  const localPath = item.localPath;
  const remotePath = item.remotePath;
  const steps: SyncPlanStep[] = choice === "keep-local"
    ? [
        { kind: "upload-update", sourcePath: localPath, targetPath: remotePath, destructive: true, requiresFreshRemoteEtag: true, description: "Apply the explicitly chosen LOCAL version using the current remote fileId and ETag." },
        { kind: "establish-baseline", sourcePath: localPath, targetPath: null, destructive: false, requiresFreshRemoteEtag: false, description: "Create a new common ancestor only after both selected replicas are hash-verified equal." }
      ]
    : [
        { kind: "download-update", sourcePath: remotePath, targetPath: localPath, destructive: true, requiresFreshRemoteEtag: true, description: "Apply the explicitly chosen REMOTE version using the current fileId and ETag, after verifying the local preservation copy." },
        { kind: "establish-baseline", sourcePath: remotePath, targetPath: null, destructive: false, requiresFreshRemoteEtag: false, description: "Create a new common ancestor only after both selected replicas are hash-verified equal." }
      ];
  const resolved: SyncPlanItem = {
    ...item,
    disposition: "ready",
    reasons: [...item.reasons, `User explicitly chose ${choice === "keep-local" ? "LOCAL" : "REMOTE"}; the displaced version was preserved as a conflict copy first.`],
    steps
  };
  const items = [resolved];
  const summary = {
    total: 1,
    noop: 0,
    ready: 1,
    needsVerification: 0,
    mergeCandidates: 0,
    blocked: 0,
    destructiveSteps: 1,
    remoteVerifications: 0
  };
  const selectedPlan: SyncPlan = { ...plan, items, summary, fingerprint: "" };
  selectedPlan.fingerprint = await fingerprintSyncPlan(selectedPlan);
  return selectedPlan;
}

export function assertConflictChoiceEligible(item: SyncPlanItem | undefined): asserts item is SyncPlanItem {
  if (!item || (item.disposition !== "blocked" && item.disposition !== "merge-candidate")) throw new Error("This conflict is no longer current; rebuild the sync plan.");
  if (item.classification !== "both-change" && item.classification !== "concurrent-create") {
    throw new Error("This conflict involves a rename, deletion, or path identity. It needs path-specific review and cannot use a keep-side shortcut.");
  }
  if (!item.localPath || !item.remotePath || item.localPath !== item.remotePath) {
    throw new Error("Keep-side choices require both versions to exist at the same path.");
  }
  if (!item.remoteContentKnown) throw new Error("The remote version must be downloaded and hash-verified before resolving this conflict.");
}
