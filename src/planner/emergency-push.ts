import type { DurableState } from "../state/durable/model";
import { fingerprintSyncPlan } from "./planner";
import type { SyncPlan, SyncPlanItem, SyncPlanStep } from "./types";

/** A Nextcloud copy this much newer than the local one is left to the normal sync, which keeps both versions. */
export const EMERGENCY_PUSH_NEWER_REMOTE_TOLERANCE_MS = 2_000;

export interface EmergencyPushStats {
  /** Files that do not exist on Nextcloud and are uploaded as new. */
  create: number;
  /** Files whose Nextcloud copy differs and is replaced by this device's version (Nextcloud keeps the old version). */
  update: number;
  /** Files whose Nextcloud copy still has to be read once to learn its hash. */
  verifying: number;
  /** Files that are already identical on Nextcloud. */
  same: number;
  /** Files where Nextcloud holds a clearly newer version; the normal sync settles those and keeps both. */
  deferred: number;
  /** Files that exist only on Nextcloud; an upload never touches them. */
  remoteOnly: number;
}

function step(kind: SyncPlanStep["kind"], sourcePath: string | null, targetPath: string | null, requiresFreshRemoteEtag: boolean, description: string): SyncPlanStep {
  return { kind, sourcePath, targetPath, destructive: false, requiresFreshRemoteEtag, description };
}

/**
 * Turns a fresh plan into a one-way "this device is the truth" upload: whatever this device has and
 * Nextcloud lacks (or holds in a different, not clearly newer version) is uploaded. Nothing is deleted
 * and nothing is downloaded. `limit` caps how many items one round executes so progress is committed in
 * steps and a failing file cannot take a whole vault down with it.
 */
export async function makeEmergencyPushPlan(
  plan: SyncPlan,
  state: DurableState,
  options: { limit: number; skip?: ReadonlySet<string> }
): Promise<{ plan: SyncPlan; stats: EmergencyPushStats }> {
  const stats: EmergencyPushStats = { create: 0, update: 0, verifying: 0, same: 0, deferred: 0, remoteOnly: 0 };
  const selected: SyncPlanItem[] = [];

  for (const item of plan.items) {
    const record = state.files[item.entryId];
    const local = record?.local ?? null;
    const remote = record?.remote ?? null;
    if (!record || !local) { if (item.disposition !== "noop") stats.remoteOnly += 1; continue; }
    if (options.skip?.has(item.entryId)) continue;

    let next: SyncPlanItem | null = null;
    if (!remote) {
      stats.create += 1;
      next = {
        ...item, classification: "local-create", disposition: "ready",
        reasons: ["This device has the file and Nextcloud does not; it is uploaded."],
        steps: [
          step("upload-create", local.path, local.path, false, "Create the file on Nextcloud with create-only preconditions."),
          step("establish-baseline", local.path, null, false, "Record the verified upload as the common ancestor.")
        ]
      };
    } else if (remote.contentHash === null) {
      stats.verifying += 1;
      next = {
        ...item, classification: "needs-remote-verification", disposition: "needs-verification",
        reasons: ["The Nextcloud copy has to be read once to compare it with this device."],
        steps: [step("verify-remote-content", remote.path, null, true, "Read the Nextcloud bytes without changing them and store their hash.")]
      };
    } else if (remote.contentHash === local.contentHash) {
      stats.same += 1;
      if (item.disposition === "noop") continue;
      next = {
        ...item, classification: "converged-unbaselined", disposition: "ready",
        reasons: ["Both sides already hold the same bytes."],
        steps: [step("establish-baseline", local.path, null, false, "Adopt the identical verified content as the common ancestor.")]
      };
    } else if (local.path !== remote.path || (remote.mtimeMs !== null && remote.mtimeMs - local.mtimeMs > EMERGENCY_PUSH_NEWER_REMOTE_TOLERANCE_MS)) {
      stats.deferred += 1;
      continue;
    } else {
      stats.update += 1;
      next = {
        ...item, classification: "local-change", disposition: "ready",
        reasons: ["Nextcloud holds a different, not newer version; this device's version replaces it and Nextcloud keeps the old one."],
        steps: [
          step("upload-update", local.path, remote.path, true, "Upload this device's version using the current Nextcloud fileId and ETag."),
          step("establish-baseline", local.path, null, false, "Record the verified upload as the common ancestor.")
        ]
      };
    }
    if (next) selected.push(next);
  }

  const items = selected.slice(0, Math.max(1, options.limit));
  const summary = {
    total: items.length,
    noop: 0,
    ready: items.filter((item) => item.disposition === "ready").length,
    needsVerification: items.filter((item) => item.disposition === "needs-verification").length,
    mergeCandidates: 0,
    blocked: 0,
    destructiveSteps: 0,
    remoteVerifications: items.filter((item) => item.steps.some((candidate) => candidate.kind === "verify-remote-content")).length
  };
  const pushPlan: SyncPlan = { ...plan, items, summary, fingerprint: "" };
  pushPlan.fingerprint = await fingerprintSyncPlan(pushPlan);
  return { plan: pushPlan, stats };
}
