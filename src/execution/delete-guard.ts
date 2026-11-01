import type { SyncPlan } from "../planner/types";

export interface DeleteGuardInput {
  /** Maximum deletions per sync before approval is required; 0 disables the guard. */
  threshold: number;
  /** Number of files currently tracked, to catch "most of the vault vanished" below the absolute threshold. */
  trackedFiles: number;
  /** Deletions the user already approved for the next sync. */
  approvedItems: number;
  /** Tracked files this device currently has / Nextcloud currently has; zero with a populated history means the side looks wiped. */
  localReplicas?: number;
  remoteReplicas?: number;
}

export interface DeleteGuardDecision {
  /** Whether the deletions must wait for approval. */
  held: boolean;
  localDeletes: number;
  remoteDeletes: number;
  total: number;
  /** Up to ten affected paths for the approval prompt. */
  sample: string[];
  /**
   * Why the batch looks like an accident rather than an edit: one whole side of the vault is gone. Such a
   * batch is never released automatically; only an explicit user approval lets it through.
   */
  suspicious: "local-vault-empty" | "remote-vault-empty" | null;
}

const MIN_FRACTION_COUNT = 5;
const FRACTION = 0.5;

/** Counts the deletions an executable plan would perform and decides whether they need approval. */
export function evaluateDeleteGuard(plan: SyncPlan, input: DeleteGuardInput): DeleteGuardDecision {
  let localDeletes = 0;
  let remoteDeletes = 0;
  const sample: string[] = [];
  for (const item of plan.items) {
    if (item.disposition === "blocked" || item.disposition === "noop") continue;
    for (const step of item.steps) {
      if (step.kind === "delete-local") localDeletes += 1;
      else if (step.kind === "delete-remote") remoteDeletes += 1;
      else continue;
      if (sample.length < 10) sample.push(item.displayPath);
    }
  }
  const total = localDeletes + remoteDeletes;
  const overThreshold = input.threshold > 0 && total > input.threshold;
  const mostOfVault = total >= MIN_FRACTION_COUNT && input.trackedFiles > 0 && total > input.trackedFiles * FRACTION;
  // Deleting the other side's files because this side shows nothing is how a failed read (an unmounted or
  // wiped vault, an empty listing) turns into data loss. Hold that at any size, small vaults included.
  const suspicious: DeleteGuardDecision["suspicious"] =
    input.trackedFiles > 0 && input.localReplicas === 0 && remoteDeletes > 0 ? "local-vault-empty"
      : input.trackedFiles > 0 && input.remoteReplicas === 0 && localDeletes > 0 ? "remote-vault-empty"
        : null;
  const held = total > 0 && (overThreshold || mostOfVault || suspicious !== null) && total > input.approvedItems;
  return { held, localDeletes, remoteDeletes, total, sample, suspicious };
}
