import type { Logger } from "../diagnostics/logger";
import { errorMessage } from "../core/errors";
import { occupiedDirectories, planFolderSync } from "./folder-plan";
import type { FolderBaselineStore } from "./folder-baseline";

export interface LocalTree {
  folders: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

export interface FolderSyncPorts {
  listLocalTree(): Promise<LocalTree>;
  createLocalFolder(path: string): Promise<void>;
  /** Removes the folder only if it is still empty; returns whether it was removed. */
  removeLocalFolderIfEmpty(path: string): Promise<boolean>;
  createRemoteFolder(path: string): Promise<void>;
  /** Removes the collection only if it is still empty; returns whether it was removed. */
  removeRemoteFolderIfEmpty(path: string): Promise<boolean>;
}

export interface FolderSyncInput {
  remoteFolders: readonly string[];
  remoteFiles: readonly string[];
  allowDeletes: boolean;
  /** Deleting more folders than this in one run is held back for approval; undefined means no limit. */
  maxDeletes?: number;
}

export interface FolderOperation {
  action: "created" | "deleted";
  side: "local" | "remote";
  path: string;
}

export interface FolderSyncResult {
  created: number;
  deleted: number;
  failed: number;
  /** Folder deletions withheld because they exceeded `maxDeletes`. */
  held: number;
  operations: FolderOperation[];
}

/**
 * Mirrors directories, including empty ones, after the file engine has converged.
 * Operations are individually idempotent and re-derived from fresh facts on every
 * cycle, so a failure only delays that folder to the next cycle.
 */
export class FolderSyncService {
  constructor(
    private readonly ports: FolderSyncPorts,
    private readonly baseline: FolderBaselineStore,
    private readonly logger: Logger
  ) {}

  async run(input: FolderSyncInput): Promise<FolderSyncResult> {
    const tree = await this.ports.listLocalTree();
    const facts = {
      local: tree.folders,
      remote: new Set(input.remoteFolders),
      baseline: await this.baseline.load(),
      localOccupied: occupiedDirectories(tree.files),
      remoteOccupied: occupiedDirectories(input.remoteFiles)
    };
    let plan = planFolderSync({ ...facts, allowDeletes: input.allowDeletes });
    let held = 0;
    const planned = plan.deleteRemote.length + plan.deleteLocal.length;
    if (input.maxDeletes !== undefined && planned > input.maxDeletes) {
      // Too many folder removals for one sync: keep everything and let the user decide.
      held = planned;
      plan = planFolderSync({ ...facts, allowDeletes: false });
    }
    this.logger.debug("folders.planned", {
      local: tree.folders.size, remote: input.remoteFolders.length,
      createRemote: plan.createRemote.length, createLocal: plan.createLocal.length, deleteRemote: plan.deleteRemote.length, deleteLocal: plan.deleteLocal.length, held
    });
    const result: FolderSyncResult = { created: 0, deleted: 0, failed: 0, held, operations: [] };
    const next = plan.nextBaseline;

    const attempt = async (action: string, operation: () => Promise<boolean>, onSuccess: () => void, onFailure: () => void): Promise<void> => {
      try {
        if (await operation()) { onSuccess(); return; }
        onFailure(); // not empty any more: leave it for the file engine and retry later
      } catch (error) {
        result.failed += 1;
        onFailure();
        this.logger.warn("folders.operation-failed", { action, error: errorMessage(error) });
      }
    };
    const created = (side: FolderOperation["side"], path: string) => () => { result.created += 1; result.operations.push({ action: "created", side, path }); };
    const deleted = (side: FolderOperation["side"], path: string) => () => { result.deleted += 1; result.operations.push({ action: "deleted", side, path }); };

    for (const path of plan.createRemote) {
      await attempt("create-remote", async () => { await this.ports.createRemoteFolder(path); return true; }, created("remote", path), () => { next.delete(path); });
    }
    for (const path of plan.createLocal) {
      await attempt("create-local", async () => { await this.ports.createLocalFolder(path); return true; }, created("local", path), () => { next.delete(path); });
    }
    for (const path of plan.deleteRemote) {
      await attempt("delete-remote", async () => await this.ports.removeRemoteFolderIfEmpty(path), deleted("remote", path), () => { next.add(path); });
    }
    for (const path of plan.deleteLocal) {
      await attempt("delete-local", async () => await this.ports.removeLocalFolderIfEmpty(path), deleted("local", path), () => { next.add(path); });
    }
    await this.baseline.save(next);
    if (result.created + result.deleted + result.failed + held > 0) this.logger.info("folders.synced", { created: result.created, deleted: result.deleted, failed: result.failed, held });
    return result;
  }
}
