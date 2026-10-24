import { Component, TFile, TFolder, type Vault } from "obsidian";
import type { Logger } from "../diagnostics/logger";
import { LocalChangeBuffer } from "./change-buffer";
import type { LocalMutationLedger } from "./mutation-ledger";
import type { LocalPathPolicy } from "./path-policy";
import type { LocalChangeBatch } from "./types";

/**
 * Obsidian Vault event adapter. Every event is first fenced synchronously in the
 * mutation ledger, then debounced into a read-only rescan request.
 */
export class LocalInventoryWatcher extends Component {
  private readonly buffer: LocalChangeBuffer;

  constructor(
    private readonly vault: Vault,
    private readonly policy: LocalPathPolicy,
    ledger: LocalMutationLedger,
    onBatch: (batch: LocalChangeBatch) => Promise<void>,
    private readonly logger: Logger,
    private readonly onActivity?: () => void
  ) {
    super();
    this.buffer = new LocalChangeBuffer(async (batch) => {
      try {
        await onBatch(batch);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) {
          this.logger.error("local.watcher-batch-failed", {
            sequence: batch.sequence,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    this.registerEvent(this.vault.on("create", (file) => {
      if (file instanceof TFolder) {
        if (!this.include(file.path)) return;
        this.onActivity?.();
        ledger.noteTreeChange();
        this.buffer.noteTreeChange(file.path);
        return;
      }
      if (!this.include(file.path)) return;
      this.onActivity?.();
      ledger.notePathChange();
      this.buffer.notePath(file.path);
    }));

    this.registerEvent(this.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || !this.include(file.path)) return;
      this.onActivity?.();
      ledger.notePathChange();
      this.buffer.notePath(file.path);
    }));

    this.registerEvent(this.vault.on("delete", (file) => {
      if (file instanceof TFolder) {
        if (!this.include(file.path)) return;
        this.onActivity?.();
        ledger.noteTreeChange();
        this.buffer.noteTreeChange(file.path);
        return;
      }
      if (!this.include(file.path)) return;
      this.onActivity?.();
      ledger.notePathChange();
      this.buffer.notePath(file.path);
    }));

    this.registerEvent(this.vault.on("rename", (file, oldPath) => {
      const oldIncludedForActivity = this.include(oldPath);
      const newIncludedForActivity = this.include(file.path);
      if (!oldIncludedForActivity && !newIncludedForActivity) return;
      this.onActivity?.();
      if (file instanceof TFolder) {
        if (oldIncludedForActivity && newIncludedForActivity) {
          ledger.noteRename(oldPath, file.path, "folder");
          this.buffer.noteRename({
            oldPath,
            newPath: file.path,
            kind: "folder",
            source: "vault-event",
            confidence: "exact"
          });
        } else {
          ledger.noteTreeChange();
        }
        this.buffer.noteTreeChange(file.path);
        return;
      }

      if (oldIncludedForActivity && newIncludedForActivity) {
        ledger.noteRename(oldPath, file.path, "file");
        this.buffer.noteRename({
          oldPath,
          newPath: file.path,
          kind: "file",
          source: "vault-event",
          confidence: "exact"
        });
      } else {
        // Crossing the sync boundary (for example moving into .trash or the
        // config directory) is observed as a tree change, never as an identity
        // preserving rename across excluded space.
        ledger.noteTreeChange();
        this.buffer.noteTreeChange(file.path);
      }
    }));
  }

  override onunload(): void {
    this.buffer.close();
  }

  /** Drain any hinted scans before a synchronization cycle snapshots local state. */
  async flushPending(): Promise<void> {
    await this.buffer.flushNow();
  }

  private include(path: string): boolean {
    return this.policy.isIncluded(path);
  }
}

