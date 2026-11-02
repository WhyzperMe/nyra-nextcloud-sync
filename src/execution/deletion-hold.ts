import type { SyncPlan } from "../planner/types";
import { evaluateDeleteGuard, type DeleteGuardDecision } from "./delete-guard";

export interface PendingDeletions {
  total: number;
  files: number;
  folders: number;
  /** Files that exist only on this device's side of the decision: deleted here, pending removal on Nextcloud. */
  pendingRemoteDeletes: number;
  /** Files deleted on Nextcloud, pending removal from this device. */
  pendingLocalDeletes: number;
  sample: string[];
  detectedAt: string;
  /** Set when a whole side of the vault looks wiped; such a batch needs a person's explicit approval. */
  suspicious: DeleteGuardDecision["suspicious"];
}

export interface ReplicaCounts { localReplicas: number; remoteReplicas: number }

const APPROVAL_TTL_MS = 15 * 60_000;

/**
 * Remembers deletions that were held back for approval and the user's approval.
 * Approval is bound to the exact pending file and folder decisions.
 */
export class DeletionHold {
  private fileDecision: DeleteGuardDecision | null = null;
  private detectedAt: string | null = null;
  private folderDeletes = 0;
  private fileKey: string | null = null;
  private folderKey: string | null = null;
  private fileReviewRequired = false;
  private folderReviewRequired = false;
  private approval: { fileKey: string | null; folderKey: string | null; items: number; expiresAt: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Evaluates a plan and updates the pending state. Returns whether it is newly held. */
  evaluate(plan: SyncPlan, threshold: number, trackedFiles: number, sides?: ReplicaCounts): { decision: DeleteGuardDecision; newlyHeld: boolean } {
    const key = fileDeletionKey(plan);
    const hadFileApproval = this.approvedItems() > 0 && this.approval?.fileKey != null;
    const approved = hadFileApproval && this.approval?.fileKey === key;
    const decision = evaluateDeleteGuard(plan, { threshold, trackedFiles, approvedItems: approved ? this.approvedItems() : 0, ...sides });
    // A changed batch must be reviewed again even if it now falls below the usual threshold.
    if (hadFileApproval && !approved && decision.total > 0) this.fileReviewRequired = true;
    if (decision.total === 0 || approved) this.fileReviewRequired = false;
    if (this.fileReviewRequired && decision.total > 0) decision.held = true;
    const wasHeld = this.fileDecision !== null;
    if (this.fileKey !== key && decision.total > 0) {
      this.detectedAt = new Date(this.now()).toISOString();
      if (this.approval?.fileKey !== key) this.approval = null;
    }
    this.fileKey = decision.total > 0 ? key : null;
    // An approval belongs to the deletions the user was shown; once they are gone it must not linger.
    if (decision.total === 0 && this.approval && this.folderDeletes === 0) this.approval = null;
    if (decision.held) {
      this.fileDecision = decision;
      this.detectedAt ??= new Date(this.now()).toISOString();
    } else {
      this.fileDecision = null;
      if (this.folderDeletes === 0) this.detectedAt = null;
    }
    return { decision, newlyHeld: decision.held && !wasHeld };
  }

  approvedItems(): number {
    if (!this.approval) return 0;
    if (this.now() > this.approval.expiresAt) { this.approval = null; return 0; }
    return this.approval.items;
  }

  /** Folder approvals are evaluated separately against their exact paths and directions. */
  folderLimit(threshold: number): number | undefined {
    if (threshold <= 0) return undefined;
    return threshold;
  }

  setHeldFolders(count: number, key: string | null = null): void {
    if (count > 0 && this.folderKey !== key) {
      this.detectedAt = new Date(this.now()).toISOString();
      if (this.approval?.folderKey !== key) this.approval = null;
    }
    this.folderDeletes = count;
    this.folderKey = count > 0 ? key : null;
    if (count > 0) this.detectedAt ??= new Date(this.now()).toISOString();
    else if (this.fileDecision === null) this.detectedAt = null;
  }

  summary(): PendingDeletions | null {
    const files = this.fileDecision?.total ?? 0;
    if (files + this.folderDeletes === 0 || this.detectedAt === null) return null;
    return {
      total: files + this.folderDeletes,
      files,
      folders: this.folderDeletes,
      pendingRemoteDeletes: this.fileDecision?.remoteDeletes ?? 0,
      pendingLocalDeletes: this.fileDecision?.localDeletes ?? 0,
      sample: this.fileDecision?.sample ?? [],
      detectedAt: this.detectedAt,
      suspicious: this.fileDecision?.suspicious ?? null
    };
  }

  /** Approves what is currently held. Returns false when nothing is pending. */
  approve(): boolean {
    const pending = this.summary();
    if (!pending) return false;
    this.approval = { fileKey: this.fileDecision ? this.fileKey : null, folderKey: this.folderKey, items: Math.max(pending.total, 1), expiresAt: this.now() + APPROVAL_TTL_MS };
    return true;
  }

  /**
   * Autonomous approval for held deletions. A batch is released only when it has stood unchanged for
   * `graceMs`, removes at most `maxShare` of the tracked files, never touches Nextcloud (a deletion
   * there is only ever carried out on a person's say-so) and does not look like a wiped side. Anything
   * else keeps waiting for a person.
   */
  autoApprove(graceMs: number, maxShare: number, trackedFiles: number): boolean {
    const pending = this.summary();
    if (!pending || this.approvedItems() > 0) return false;
    if (pending.suspicious !== null || pending.pendingRemoteDeletes > 0 || pending.folders > 0) return false;
    if (this.now() - Date.parse(pending.detectedAt) < graceMs) return false;
    if (trackedFiles <= 0 || pending.total > trackedFiles * maxShare) return false;
    return this.approve();
  }

  /**
   * Called after approved file deletions ran. An approval that also covers held folders stays valid
   * for the folder pass that follows in the same sync; otherwise the user would have to approve twice.
   */
  consumeFileApproval(): void {
    this.fileDecision = null;
    this.fileKey = null;
    this.fileReviewRequired = false;
    if (this.approval?.folderKey != null && this.folderDeletes > 0) this.approval = { ...this.approval, fileKey: null };
    else this.approval = null;
    if (this.folderDeletes === 0) this.detectedAt = null;
  }

  /** Called after a sync ran with an approval in force. */
  consumeApproval(): void {
    this.approval = null;
    this.fileDecision = null;
    this.fileKey = null;
    this.folderDeletes = 0;
    this.folderKey = null;
    this.fileReviewRequired = false;
    this.folderReviewRequired = false;
    this.detectedAt = null;
  }

  /** Drops any pending hold and approval, for example when automatic deletion is switched off. */
  reset(): void { this.consumeApproval(); }

  hasApproval(): boolean { return this.approvedItems() > 0; }

  hasFileApproval(plan: SyncPlan): boolean {
    return this.approvedItems() > 0 && this.approval?.fileKey === fileDeletionKey(plan);
  }

  /** Called with a newly computed folder plan before any folder is removed. */
  approveFolderPlan(local: readonly string[], remote: readonly string[], threshold: number): boolean {
    const total = local.length + remote.length;
    const key = JSON.stringify([ [...local].sort(), [...remote].sort() ]);
    const hadFolderApproval = this.approvedItems() > 0 && this.approval?.folderKey != null;
    const approved = total > 0 && hadFolderApproval && this.approval?.folderKey === key;
    if (hadFolderApproval && !approved && total > 0) this.folderReviewRequired = true;
    if (total === 0 || approved) this.folderReviewRequired = false;
    if (total > 0 && !approved && ((threshold > 0 && total > threshold) || this.folderReviewRequired)) {
      this.setHeldFolders(total, key);
      return false;
    }
    this.setHeldFolders(0);
    return true;
  }
}

function fileDeletionKey(plan: SyncPlan): string {
  const entries = plan.items.flatMap((item) => item.disposition === "blocked" || item.disposition === "noop" ? [] :
    item.steps.filter((step) => step.kind === "delete-local" || step.kind === "delete-remote")
      .map((step) => JSON.stringify([item.entryId, item.displayPath, item.baselinePath, item.localPath, item.remotePath, step.kind, step.sourcePath, step.targetPath])))
    .sort();
  return JSON.stringify([plan.storeId, plan.stateGeneration, plan.walSequence, plan.walHash, entries]);
}
