import type { FileReplicaRecord } from "../state/durable/model";
import { fingerprintSyncPlan } from "./planner";
import type { SyncPlan, SyncPlanItem, SyncPlanStep } from "./types";

/**
 * Autonomous conflict policy. Nothing here ever discards data:
 *
 *  - two different contents at one path: the newer one stays at the path (ties and unknown times
 *    fall back to the larger SHA-256, so every device decides the same way) and the other version
 *    is first preserved as a conflict copy that syncs like any other note;
 *  - deleted on one side, changed on the other: the change wins and the file is restored;
 *  - renamed to different paths on both sides: the Nextcloud path wins, the local file follows it.
 */
export type AutoResolution =
  | { kind: "keep-local" | "keep-remote"; reason: string }
  | { kind: "restore-local" | "restore-remote" | "adopt-remote-path"; reason: string };

/** Clock differences up to this many milliseconds are treated as "same time" (filesystem granularity, server rounding). */
export const AUTO_RESOLUTION_TIME_TOLERANCE_MS = 2_000;

export function decideAutoResolution(item: SyncPlanItem, record: FileReplicaRecord): AutoResolution | null {
  if (item.disposition !== "blocked" && item.disposition !== "merge-candidate") return null;
  const { local, remote, baseline } = record;

  if ((item.classification === "both-change" || item.classification === "concurrent-create") && local && remote) {
    if (local.path !== remote.path || !remote.contentHash || !remote.fileId || !remote.etag) return null;
    if (local.contentHash === remote.contentHash) return null;
    const remoteTime = remote.mtimeMs;
    const clearlyNewer = remoteTime !== null && Math.abs(local.mtimeMs - remoteTime) > AUTO_RESOLUTION_TIME_TOLERANCE_MS;
    if (clearlyNewer) {
      return local.mtimeMs > remoteTime
        ? { kind: "keep-local", reason: "The version on this device is newer; the Nextcloud version is kept as a conflict copy." }
        : { kind: "keep-remote", reason: "The Nextcloud version is newer; this device's version is kept as a conflict copy." };
    }
    return local.contentHash > remote.contentHash
      ? { kind: "keep-local", reason: "Both versions are equally recent; the tie was broken deterministically and the other version is kept as a conflict copy." }
      : { kind: "keep-remote", reason: "Both versions are equally recent; the tie was broken deterministically and the other version is kept as a conflict copy." };
  }

  if (item.classification === "delete-vs-change") {
    if (!local && remote && remote.fileId && remote.etag) {
      return { kind: "restore-local", reason: "The file was deleted here but changed or renamed on Nextcloud; the change wins and the file is restored." };
    }
    if (local && !remote) {
      return { kind: "restore-remote", reason: "The file was deleted on Nextcloud but changed or renamed here; the change wins and the file is restored." };
    }
    return null;
  }

  if (item.classification === "rename-conflict" && local && remote && baseline && local.path !== remote.path) {
    return { kind: "adopt-remote-path", reason: "Both sides renamed the file differently; the Nextcloud name is used on every device." };
  }
  return null;
}

/**
 * One-record plan that applies a restore or rename resolution. Built from a fresh plan so it binds to
 * the exact durable state, like the explicit-choice plans.
 */
export async function makeAutoResolutionPlan(plan: SyncPlan, entryId: string, resolution: AutoResolution): Promise<SyncPlan> {
  const item = plan.items.find((candidate) => candidate.entryId === entryId);
  if (!item) throw new Error("This conflict is no longer current; rebuild the sync plan.");
  const step = (kind: SyncPlanStep["kind"], sourcePath: string | null, targetPath: string | null, destructive: boolean, requiresFreshRemoteEtag: boolean, description: string): SyncPlanStep =>
    ({ kind, sourcePath, targetPath, destructive, requiresFreshRemoteEtag, description });

  let steps: SyncPlanStep[];
  if (resolution.kind === "restore-local") {
    const remotePath = item.remotePath!;
    steps = [
      step("download-create", remotePath, remotePath, false, true, "Restore the changed Nextcloud version on this device; the local path is free because the file was deleted here."),
      step("establish-baseline", remotePath, null, false, false, "Create a new common ancestor after the restored file is hash-verified.")
    ];
  } else if (resolution.kind === "restore-remote") {
    const localPath = item.localPath!;
    steps = [
      step("upload-create", localPath, localPath, false, false, "Restore the changed local version on Nextcloud with create-only preconditions."),
      step("establish-baseline", localPath, null, false, false, "Create a new common ancestor after the upload is verified.")
    ];
  } else if (resolution.kind === "adopt-remote-path") {
    steps = [
      step("move-local", item.localPath, item.remotePath, false, false, "Move the local file to the Nextcloud name; the move is refused if that path is occupied.")
    ];
  } else {
    throw new Error("Keep-side resolutions use the explicit conflict-choice plan.");
  }

  const resolved: SyncPlanItem = { ...item, disposition: "ready", reasons: [...item.reasons, resolution.reason], steps };
  const summary = { total: 1, noop: 0, ready: 1, needsVerification: 0, mergeCandidates: 0, blocked: 0, destructiveSteps: 0, remoteVerifications: 0 };
  const selected: SyncPlan = { ...plan, items: [resolved], summary, fingerprint: "" };
  selected.fingerprint = await fingerprintSyncPlan(selected);
  return selected;
}
