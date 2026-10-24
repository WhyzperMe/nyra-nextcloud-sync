import type { SyncPlan } from "../planner/types";

export interface DeleteGuardInput {
  /** Maximum deletions per sync before approval is required; 0 disables the guard. */
  threshold: number;
  /** Number of files currently tracked, to catch "most of the vault vanished" below the absolute threshold. */
  trackedFiles: number;
  /** Deletions the user already approved for the next sync. */
  approvedItems: number;
}

export interface DeleteGuardDecision {
  /** Whether the deletions must wait for approval. */
  held: boolean;
  localDeletes: number;
  remoteDeletes: number;
  total: number;
  /** Up to ten affected paths for the approval prompt. */
  sample: string[];
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
  const held = total > 0 && (overThreshold || mostOfVault) && total > input.approvedItems;
  return { held, localDeletes, remoteDeletes, total, sample };
}
