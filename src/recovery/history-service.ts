import type { ActivityLog } from "../activity/activity-log";
import type { DurableState, FileReplicaRecord, RemoteReplicaState } from "../state/durable/model";
import { canonicalVaultRelativePath } from "../state/durable/path";
import type { FileVersion, NextcloudVersions } from "./file-versions";

const PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024;

export interface HistoryDeps {
  state(): DurableState;
  /** Reads a local file whose content hash must still match. */
  readLocal(path: string, expectedHash: string): Promise<ArrayBuffer>;
  /** Atomically writes a local file; `expectedHash` null means the target must not exist. */
  writeLocal(path: string, bytes: ArrayBuffer, expectedHash: string | null): Promise<void>;
  exists(path: string): Promise<boolean>;
  getBlob(hash: string): Promise<ArrayBuffer>;
  /** Downloads the exact remote version described by `remote` (fenced by its file ID and ETag). */
  downloadRemote(remote: RemoteReplicaState): Promise<ArrayBuffer>;
  versions(): NextcloudVersions;
  activity: ActivityLog;
  noteLocalActivity(): void;
}

export interface ConflictPreview {
  local: string | null;
  base: string | null;
  remote: string | null;
  unavailable?: string;
}

/** Conflict comparison and Nextcloud version history: read-mostly views over a synced note. */
export class HistoryService {
  constructor(private readonly deps: HistoryDeps) {}

  /** Both sides of a conflict as text. Binary or very large files are not previewed. */
  async conflictPreview(entryId: string): Promise<ConflictPreview> {
    const record = this.deps.state().files[entryId];
    const none = (unavailable: string): ConflictPreview => ({ local: null, base: null, remote: null, unavailable });
    if (!record?.local || !record.remote?.fileId || !record.remote.etag) return none("Both versions must be known before they can be compared.");
    if (record.local.size > PREVIEW_LIMIT_BYTES || record.remote.size > PREVIEW_LIMIT_BYTES) return none(`Files above ${PREVIEW_LIMIT_BYTES / 1024 / 1024} MiB are not compared here.`);
    const local = decodeUtf8(await this.deps.readLocal(record.local.path, record.local.contentHash));
    const base = record.baseline ? decodeUtf8(await this.deps.getBlob(record.baseline.blobHash)) : null;
    const remote = decodeUtf8(await this.deps.downloadRemote(record.remote));
    if (local === null || remote === null) return none("These files are not plain text, so they cannot be compared line by line.");
    return { local, base, remote };
  }

  async listVersions(path: string): Promise<FileVersion[]> {
    return await this.deps.versions().list(this.syncedRecord(path).remote!.fileId!);
  }

  /** Current local text and a stored version's text, or null when either is not UTF-8 text or too large. */
  async compareVersion(path: string, version: FileVersion): Promise<{ current: string; version: string } | null> {
    const record = this.syncedRecord(path);
    if (!record.local) throw new Error("The note is not available locally.");
    if (record.local.size > PREVIEW_LIMIT_BYTES || version.size > PREVIEW_LIMIT_BYTES) return null;
    const current = decodeUtf8(await this.deps.readLocal(record.local.path, record.local.contentHash));
    const stored = decodeUtf8(await this.deps.versions().download(record.remote!.fileId!, version));
    return current === null || stored === null ? null : { current, version: stored };
  }

  /**
   * "copy" writes the old version next to the note. "replace" overwrites a fully synced note; its
   * previous text stays on Nextcloud as an earlier version. Returns the path written.
   */
  async restoreVersion(path: string, version: FileVersion, mode: "copy" | "replace"): Promise<string> {
    const record = this.syncedRecord(path);
    const bytes = await this.deps.versions().download(record.remote!.fileId!, version);
    let target = record.local?.path ?? canonicalVaultRelativePath(path);
    if (mode === "replace") {
      if (!record.local || !record.baseline || record.local.contentHash !== record.baseline.blobHash) {
        throw new Error("This note has changes that are not synced yet. Sync first, or restore the version as a copy.");
      }
      await this.deps.writeLocal(target, bytes, record.local.contentHash);
    } else {
      target = await this.freeCopyPath(target, version);
      await this.deps.writeLocal(target, bytes, null);
    }
    await this.deps.activity.add([{ at: new Date().toISOString(), kind: "downloaded", path: target, detail: `Restored version from ${version.modifiedAt.slice(0, 16).replace("T", " ")}` }]);
    this.deps.noteLocalActivity();
    return target;
  }

  private syncedRecord(path: string): FileReplicaRecord {
    const state = this.deps.state();
    const entryId = state.pathIndex[canonicalVaultRelativePath(path)];
    const record = entryId ? state.files[entryId] : undefined;
    if (!record?.remote?.fileId) throw new Error("This note has not been synced to Nextcloud yet, so it has no versions.");
    return record;
  }

  private async freeCopyPath(path: string, version: FileVersion): Promise<string> {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    const stamp = version.modifiedAt.slice(0, 16).replace("T", " ").replace(":", "-");
    for (let index = 0; index < 100; index += 1) {
      const candidate = `${directory}${stem} (version ${stamp}${index === 0 ? "" : ` ${index + 1}`})${extension}`;
      if (!await this.deps.exists(candidate)) return candidate;
    }
    throw new Error("Could not find a free name for the restored version.");
  }
}

function decodeUtf8(bytes: ArrayBuffer): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
