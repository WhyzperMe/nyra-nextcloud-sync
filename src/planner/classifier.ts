import type { FileReplicaRecord } from "../state/durable/model";
import { remoteContentRelation } from "../sync/derived-status";
import type { SyncPlanItem, SyncPlanStep } from "./types";

export interface PlannerCollisionContext {
  collidingEntryIds: ReadonlySet<string>;
  collisionPathsByEntryId: ReadonlyMap<string, readonly string[]>;
  deletedEntryIds: ReadonlySet<string>;
}

export function classifyRecord(record: FileReplicaRecord, collisions: PlannerCollisionContext): SyncPlanItem {
  const baseline = record.baseline;
  const local = record.local;
  const remote = record.remote;
  const displayPath = local?.path ?? remote?.path ?? baseline?.path ?? record.path;

  if (collisions.collidingEntryIds.has(record.entryId)) {
    const paths = collisions.collisionPathsByEntryId.get(record.entryId) ?? [];
    return item(record, displayPath, "path-identity-collision", "blocked", [
      `The file path ${paths.join(", ") || displayPath} collides with another replica's path or required parent directory.`,
      "Automatic mutation is blocked until path ownership, letter case and Unicode naming are unambiguous across devices."
    ], [manualStep(displayPath, "Resolve the file or directory path collision before synchronization.")]);
  }

  if (!baseline) {
    if ((!local || !remote) && collisions.deletedEntryIds.has(record.entryId)) {
      return item(record, displayPath, "delete-vs-change", "blocked", [
        "A replica was deleted before a verified common ancestor was established.",
        "Review the remaining version; automatic restore or deletion would guess your intent."
      ], [manualStep(displayPath, "Review the remaining version before restoring or removing it.")]);
    }
    return classifyWithoutBaseline(record, displayPath);
  }

  const localPathChanged = local ? local.path !== baseline.path : null;
  const remotePathChanged = remote ? remote.path !== baseline.path : null;
  const localContentChanged = local ? local.contentHash !== baseline.blobHash : null;
  const relation = remoteContentRelation(record);
  const remoteContentKnown = remote !== null && relation !== "unknown";
  const remoteContentChanged = remote ? relation === "different" ? true : relation === "same" ? false : null : null;
  const remoteIdentityChanged = remote
    ? baseline.remoteFileId !== null && remote.fileId !== null && remote.fileId !== baseline.remoteFileId
    : null;
  const localChanged = local ? Boolean(localPathChanged || localContentChanged) : null;
  const remoteChanged = remote
    ? remoteContentChanged === null
      ? (remotePathChanged || remoteIdentityChanged ? true : null)
      : Boolean(remotePathChanged || remoteContentChanged || remoteIdentityChanged)
    : null;

  const facts = { localChanged, remoteChanged, localPathChanged, remotePathChanged, remoteIdentityChanged, remoteContentKnown };

  if (!local && !remote) {
    return item(record, displayPath, "both-delete", "ready", ["Both replicas are absent and a baseline exists."], [
      step("retire-record", baseline.path, null, false, false, "Retire the fully deleted durable record after tombstone policy is satisfied.")
    ], facts);
  }

  if (!local && remote) {
    if (remote.path !== baseline.path) {
      return item(record, displayPath, "delete-vs-change", "blocked", ["Local deletion conflicts with a remote rename."], [manualStep(displayPath, "Choose whether the local deletion or remote rename should win.")], facts);
    }
    if (relation === "unknown") return verificationItem(record, displayPath, "Local is deleted; remote content must be verified before a destructive decision.", facts);
    if (relation === "different") {
      return item(record, displayPath, "delete-vs-change", "blocked", ["Local deletion conflicts with a remote content modification."], [manualStep(displayPath, "Resolve delete-versus-modify conflict.")], facts);
    }
    return item(record, displayPath, "local-delete", "ready", ["Local replica is deleted while remote still matches the common ancestor."], [
      step("delete-remote", remote.path, null, true, true, "Delete the unchanged remote replica using its exact current ETag as a precondition."),
      step("retire-record", baseline.path, null, false, false, "Retire metadata only after the remote delete commits.")
    ], facts);
  }

  if (local && !remote) {
    if (local.path !== baseline.path || local.contentHash !== baseline.blobHash) {
      return item(record, displayPath, "delete-vs-change", "blocked", ["Remote deletion conflicts with a local rename or content modification."], [manualStep(displayPath, "Resolve local-change-versus-remote-delete conflict.")], facts);
    }
    return item(record, displayPath, "remote-delete", "ready", ["Remote replica is deleted while local still matches the common ancestor."], [
      step("delete-local", local.path, null, true, false, "Delete the unchanged local replica using a fresh local precondition check."),
      step("retire-record", baseline.path, null, false, false, "Retire metadata only after the local delete commits.")
    ], facts);
  }

  if (!local || !remote) {
    return item(record, displayPath, "invalid-state", "blocked", ["Replica state could not be classified safely."], [manualStep(displayPath, "Inspect the durable record before continuing.")], facts);
  }

  const pathConflict = local.path !== baseline.path && remote.path !== baseline.path && local.path !== remote.path;
  if (pathConflict) {
    return item(record, displayPath, "rename-conflict", "blocked", [
      `Both replicas renamed the same baseline to different paths ('${local.path}' vs '${remote.path}').`
    ], [manualStep(displayPath, "Choose the final path before any content synchronization.")], facts);
  }

  if (relation === "unknown") {
    // A rename does not prove unchanged content; verify before choosing a write.
    return verificationItem(record, displayPath, "Remote content relation to the baseline is not proven by a trusted hash or baseline ETag anchor.", facts);
  }

  const localContent = local.contentHash !== baseline.blobHash;
  const remoteContent = relation === "different";
  const localRename = local.path !== baseline.path;
  const remoteRename = remote.path !== baseline.path;

  if (!localContent && !remoteContent && !localRename && !remoteRename) {
    if (remoteIdentityChanged) {
      return item(record, displayPath, "remote-change", "ready", [
        "Remote content still matches the common ancestor, but Nextcloud assigned a new file identity at the same path.",
        "The trusted hash proves content convergence; only the baseline identity anchor needs to advance."
      ], [
        step("establish-baseline", local.path, null, false, false, "Refresh the common ancestor with the verified replacement fileId/ETag without rewriting file content.")
      ], facts);
    }
    return item(record, displayPath, "in-sync", "noop", ["Local and remote replicas match the common ancestor."], [], facts);
  }

  if (local.contentHash === remote.contentHash && remote.contentHash !== null) {
    const steps: SyncPlanStep[] = [];
    if (local.path !== remote.path) {
      if (localRename && !remoteRename) steps.push(step("move-remote", remote.path, local.path, false, true, "Propagate the verified local rename to Nextcloud."));
      else if (remoteRename && !localRename) steps.push(step("move-local", local.path, remote.path, false, false, "Propagate the verified remote rename to the local vault."));
    }
    steps.push(step("establish-baseline", local.path === remote.path ? local.path : displayPath, null, false, false, "Advance the common ancestor after both verified contents converge."));
    return item(record, displayPath, "same-content-converged", "ready", ["Both replicas have the same trusted content hash."], steps, facts);
  }

  // One side changed: propagate path/content independently.
  if ((localContent || localRename) && !remoteContent && !remoteRename) {
    const steps: SyncPlanStep[] = [];
    if (localRename) steps.push(step("move-remote", remote.path, local.path, false, true, "Move the unchanged remote identity to the local path."));
    if (localContent) steps.push(step("upload-update", local.path, local.path, false, true, "Upload the locally modified content using the remote ETag precondition."));
    steps.push(step("establish-baseline", local.path, null, false, false, "Advance the common ancestor only after all remote mutations commit."));
    return item(record, displayPath, "local-change", "ready", ["Only the local replica changed from the common ancestor."], steps, facts);
  }

  if (!localContent && !localRename && (remoteContent || remoteRename)) {
    const steps: SyncPlanStep[] = [];
    if (remoteRename) steps.push(step("move-local", local.path, remote.path, false, false, "Move the unchanged local replica to the remote path."));
    if (remoteContent) steps.push(step("download-update", remote.path, remote.path, false, true, "Download and atomically replace local content after verifying the remote ETag."));
    steps.push(step("establish-baseline", remote.path, null, false, false, "Advance the common ancestor only after local mutation commits."));
    return item(record, displayPath, "remote-change", "ready", ["Only the remote replica changed from the common ancestor."], steps, facts);
  }

  // Orthogonal edits: rename on one side, content edit on the other, while the
  // rename side kept baseline content. These changes commute and need no merge.
  if (localRename && !localContent && !remoteRename && remoteContent) {
    return item(record, displayPath, "orthogonal-rename-content", "ready", ["Local renamed the file while remote changed only its content; the changes are orthogonal."], [
      step("download-update", remote.path, local.path, false, true, "Apply verified remote content to the locally renamed path."),
      step("move-remote", remote.path, local.path, false, true, "Propagate the local rename to the same remote identity."),
      step("establish-baseline", local.path, null, false, false, "Advance the common ancestor after both orthogonal changes commit.")
    ], facts);
  }
  if (remoteRename && !remoteContent && !localRename && localContent) {
    return item(record, displayPath, "orthogonal-rename-content", "ready", ["Remote renamed the file while local changed only its content; the changes are orthogonal."], [
      step("move-local", local.path, remote.path, false, false, "Propagate the remote rename locally."),
      step("upload-update", remote.path, remote.path, false, true, "Upload verified local content to the renamed remote identity."),
      step("establish-baseline", remote.path, null, false, false, "Advance the common ancestor after both orthogonal changes commit.")
    ], facts);
  }

  if (localContent && remoteContent) {
    if (isTextMergeCandidate(local.path, remote.path, baseline.path)) {
      const finalPath = local.path === remote.path ? local.path : displayPath;
      const steps: SyncPlanStep[] = [
        step("merge-text", remote.path, finalPath, false, true, "Verify BASE/LOCAL/REMOTE bytes and apply only a conflict-free bounded three-way text merge.")
      ];
      // Content merge and path convergence are separate operations. This is
      // important when one device renamed the note while both edited content.
      if (localRename && !remoteRename) {
        steps.push(step("move-remote", remote.path, local.path, false, true, "Propagate the local rename after merged content is verified on both replicas."));
      } else if (remoteRename && !localRename) {
        steps.push(step("move-local", local.path, remote.path, false, false, "Propagate the remote rename after merged content is verified on both replicas."));
      }
      steps.push(step("establish-baseline", finalPath, null, false, false, "Advance the common ancestor only after the conflict-free merge and any path convergence commit."));
      return item(record, displayPath, "both-change", "merge-candidate", [
        "Both replicas changed text content from the same verified common ancestor.",
        "Nyra can attempt a bounded three-way merge and will write nothing if edit regions overlap."
      ], steps, facts);
    }
    return item(record, displayPath, "both-change", "blocked", ["Both replicas changed content and the file type is not eligible for automatic text merge."], [manualStep(displayPath, "Keep both versions available and require explicit conflict resolution.")], facts);
  }

  return item(record, displayPath, "both-change", "blocked", ["The combined rename/content transition is not safely commutative."], [manualStep(displayPath, "Resolve the divergent changes explicitly.")], facts);
}

function classifyWithoutBaseline(record: FileReplicaRecord, displayPath: string): SyncPlanItem {
  const local = record.local;
  const remote = record.remote;
  const facts = {
    localChanged: local ? true : null,
    remoteChanged: remote ? true : null,
    localPathChanged: null,
    remotePathChanged: null,
    remoteIdentityChanged: null,
    remoteContentKnown: remote?.contentHash !== null && remote?.contentHash !== undefined
  };
  if (local && !remote) {
    return item(record, displayPath, "local-create", "ready", ["File exists only locally and has no common ancestor."], [
      step("upload-create", local.path, local.path, false, false, "Create the remote file with create-only preconditions."),
      step("establish-baseline", local.path, null, false, false, "Create the first common ancestor after upload verification.")
    ], facts);
  }
  if (!local && remote) {
    return item(record, displayPath, "remote-create", "ready", ["File exists only remotely and has no common ancestor."], [
      step("download-create", remote.path, remote.path, false, true, "Download to staging, hash the bytes, and create the local file only if the path is still free."),
      step("establish-baseline", remote.path, null, false, false, "Create the first common ancestor after local commit verification.")
    ], facts);
  }
  if (local && remote) {
    if (local.path !== remote.path) {
      return item(record, displayPath, "concurrent-create", "blocked", ["Unbaselined replicas share an identity record but have different paths."], [manualStep(displayPath, "Resolve the initial path identity before synchronization.")], facts);
    }
    if (remote.contentHash === null) {
      return item(record, displayPath, "needs-remote-verification", "needs-verification", ["Both sides exist but remote bytes have never been trusted-hashed."], [
        step("verify-remote-content", remote.path, null, false, true, "Read remote bytes without mutation and store a trusted content hash only if the ETag is unchanged.")
      ], facts);
    }
    if (local.contentHash === remote.contentHash) {
      return item(record, displayPath, "converged-unbaselined", "ready", ["Both unbaselined replicas have the same trusted content hash."], [
        step("establish-baseline", local.path, null, false, false, "Adopt the identical verified content as the first common ancestor.")
      ], facts);
    }
    if (isTextMergeCandidate(local.path, remote.path)) {
      return item(record, displayPath, "concurrent-create", "blocked", [
        "Both sides independently created different text at the same path, but no verified common ancestor exists.",
        "Automatic three-way merge requires BASE and will not invent an ancestor."
      ], [manualStep(displayPath, "Choose which creation to keep, or preserve both and merge explicitly.")], facts);
    }
    return item(record, displayPath, "concurrent-create", "blocked", ["Both sides independently created different binary/opaque content at the same path."], [manualStep(displayPath, "Choose which creation to keep or preserve both under different paths.")], facts);
  }
  return item(record, displayPath, "invalid-state", "blocked", ["Record has no baseline and no replicas."], [manualStep(displayPath, "Repair the invalid durable record.")], facts);
}

function verificationItem(
  record: FileReplicaRecord,
  displayPath: string,
  reason: string,
  facts: Partial<Pick<SyncPlanItem, "localChanged" | "remoteChanged" | "localPathChanged" | "remotePathChanged" | "remoteIdentityChanged" | "remoteContentKnown">>
): SyncPlanItem {
  const remotePath = record.remote?.path ?? displayPath;
  return item(record, displayPath, "needs-remote-verification", "needs-verification", [reason], [
    step("verify-remote-content", remotePath, null, false, true, "Read remote bytes without mutation; accept the hash only if fileId and ETag still match this plan.")
  ], facts);
}

function item(
  record: FileReplicaRecord,
  displayPath: string,
  classification: SyncPlanItem["classification"],
  disposition: SyncPlanItem["disposition"],
  reasons: string[],
  steps: SyncPlanStep[],
  facts: Partial<Pick<SyncPlanItem, "localChanged" | "remoteChanged" | "localPathChanged" | "remotePathChanged" | "remoteIdentityChanged" | "remoteContentKnown">> = {}
): SyncPlanItem {
  return {
    entryId: record.entryId,
    displayPath,
    baselinePath: record.baseline?.path ?? null,
    localPath: record.local?.path ?? null,
    remotePath: record.remote?.path ?? null,
    classification,
    disposition,
    reasons,
    steps,
    localChanged: facts.localChanged ?? null,
    remoteChanged: facts.remoteChanged ?? null,
    localPathChanged: facts.localPathChanged ?? null,
    remotePathChanged: facts.remotePathChanged ?? null,
    remoteIdentityChanged: facts.remoteIdentityChanged ?? null,
    remoteContentKnown: facts.remoteContentKnown ?? (record.remote?.contentHash !== null && record.remote !== null)
  };
}

function step(kind: SyncPlanStep["kind"], sourcePath: string | null, targetPath: string | null, destructive: boolean, requiresFreshRemoteEtag: boolean, description: string): SyncPlanStep {
  return { kind, sourcePath, targetPath, destructive, requiresFreshRemoteEtag, description };
}
function manualStep(path: string, description: string): SyncPlanStep {
  return step("manual-resolution", path, null, false, false, description);
}
function isTextMergeCandidate(...paths: string[]): boolean {
  // Automatic merge is deliberately limited to automatic merge to note/plain-text formats.
  // Structured JSON/YAML/Canvas and code can be syntactically invalid even when
  // textual edit regions do not overlap, so they remain explicit review items.
  const allowed = new Set(["md", "markdown", "txt"]);
  return paths.every((path) => {
    const name = path.toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot >= 0 && allowed.has(name.slice(dot + 1));
  });
}
