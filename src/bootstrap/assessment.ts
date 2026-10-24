import type { SyncPlan, SyncPlanItem, SyncPlanStepKind } from "../planner/types";
import type { BootstrapAssessment } from "./types";

const PUSH_STEPS = new Set<SyncPlanStepKind>(["upload-create", "establish-baseline"]);
const PULL_STEPS = new Set<SyncPlanStepKind>(["download-create", "establish-baseline"]);

/**
 * Pure first-link safety assessment.
 *
 * Publish is allowed only when the synchronized remote scope is empty and every
 * planned mutation is a non-destructive local create. Download is the mirror:
 * local scope must be empty and all planned mutations must be remote creates.
 * Any rename, delete, update, merge, collision, or content ambiguity falls back
 * to the normal bidirectional planner instead of being hidden inside onboarding.
 */
export function assessBootstrapPlan(plan: SyncPlan, localFiles: number, remoteFiles: number): BootstrapAssessment {
  const actionable = plan.items.filter((item) => item.disposition !== "noop");
  const publishShape = actionable.length > 0 && actionable.every(isPureLocalCreate);
  const downloadShape = actionable.length > 0 && actionable.every(isPureRemoteCreate);

  const canPublish = localFiles > 0 && remoteFiles === 0 && publishShape && plan.summary.blocked === 0 && plan.summary.mergeCandidates === 0;
  const canDownload = remoteFiles > 0 && localFiles === 0 && downloadShape && plan.summary.blocked === 0 && plan.summary.mergeCandidates === 0;

  return {
    localFiles,
    remoteFiles,
    plan,
    canPublish,
    canDownload,
    publishReason: canPublish
      ? `Ready to publish ${localFiles} file${localFiles === 1 ? "" : "s"}; the remote scope is empty.`
      : explainPublish(localFiles, remoteFiles, actionable, plan),
    downloadReason: canDownload
      ? `Ready to download ${remoteFiles} file${remoteFiles === 1 ? "" : "s"}; this device's sync scope is empty.`
      : explainDownload(localFiles, remoteFiles, actionable, plan)
  };
}

function isPureLocalCreate(item: SyncPlanItem): boolean {
  return item.classification === "local-create" && item.disposition === "ready" && item.steps.every((step) => PUSH_STEPS.has(step.kind) && !step.destructive);
}

function isPureRemoteCreate(item: SyncPlanItem): boolean {
  return item.classification === "remote-create" && item.disposition === "ready" && item.steps.every((step) => PULL_STEPS.has(step.kind) && !step.destructive);
}

function explainPublish(localFiles: number, remoteFiles: number, actionable: readonly SyncPlanItem[], plan: SyncPlan): string {
  if (localFiles === 0) return "No sync-visible local files are available to publish.";
  if (remoteFiles > 0) return "The remote folder already contains sync-visible files. Use normal bidirectional sync so nothing is overwritten.";
  if (plan.summary.blocked > 0 || plan.summary.mergeCandidates > 0) return "The current state requires review before publishing.";
  if (!actionable.every(isPureLocalCreate)) return "The current plan contains work other than new remote creates. Use normal bidirectional sync.";
  return "A fresh local and remote scan is required before publishing.";
}

function explainDownload(localFiles: number, remoteFiles: number, actionable: readonly SyncPlanItem[], plan: SyncPlan): string {
  if (remoteFiles === 0) return "The remote folder contains no sync-visible files to download.";
  if (localFiles > 0) return "This device already contains sync-visible files. Use normal bidirectional sync so local data is preserved.";
  if (plan.summary.blocked > 0 || plan.summary.mergeCandidates > 0) return "The current state requires review before downloading.";
  if (!actionable.every(isPureRemoteCreate)) return "The current plan contains work other than new local creates. Use normal bidirectional sync.";
  return "A fresh local and remote scan is required before downloading.";
}
