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
}

const APPROVAL_TTL_MS = 15 * 60_000;

/**
 * Remembers deletions that were held back for approval and the user's approval.
 * An approval covers up to the number of deletions the user was shown and expires,
 * so a later, larger surprise is held again.
 */
export class DeletionHold {
  private fileDecision: DeleteGuardDecision | null = null;
  private detectedAt: string | null = null;
  private folderDeletes = 0;
  private approval: { items: number; expiresAt: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Evaluates a plan and updates the pending state. Returns whether it is newly held. */
  evaluate(plan: SyncPlan, threshold: number, trackedFiles: number): { decision: DeleteGuardDecision; newlyHeld: boolean } {
    const decision = evaluateDeleteGuard(plan, { threshold, trackedFiles, approvedItems: this.approvedItems() });
    const wasHeld = this.fileDecision !== null;
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

  /** Folder removals allowed in one run: unlimited while approved, otherwise the threshold. */
  folderLimit(threshold: number): number | undefined {
    if (this.approvedItems() > 0 || threshold <= 0) return undefined;
    return threshold;
  }

  setHeldFolders(count: number): void {
    this.folderDeletes = count;
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
      detectedAt: this.detectedAt
    };
  }

  /** Approves what is currently held. Returns false when nothing is pending. */
  approve(): boolean {
    const pending = this.summary();
    if (!pending) return false;
    this.approval = { items: Math.max(pending.total, 1), expiresAt: this.now() + APPROVAL_TTL_MS };
    return true;
  }

  /** Called after a sync ran with an approval in force. */
  consumeApproval(): void {
    this.approval = null;
    this.fileDecision = null;
    this.folderDeletes = 0;
    this.detectedAt = null;
  }

  /** Drops any pending hold and approval, for example when automatic deletion is switched off. */
  reset(): void { this.consumeApproval(); }

  hasApproval(): boolean { return this.approvedItems() > 0; }
}
