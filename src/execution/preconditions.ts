import type { DurableState } from "../state/durable/model";
import type { SyncPlan } from "../planner/types";
import { fingerprintSyncPlan } from "../planner/planner";
import { NyraError } from "../core/errors";

export async function assertPlanMatchesState(plan: SyncPlan, state: DurableState): Promise<void> {
  if (plan.storeId !== state.storeId) throw new Error("Sync plan belongs to a different durable store.");
  if (plan.stateGeneration !== state.generation) throw new NyraError("sync-precondition-changed", "Sync plan is stale: durable generation changed.");
  if (plan.walSequence !== state.lastWalSequence || plan.walHash !== state.lastWalHash) {
    throw new NyraError("sync-precondition-changed", "Sync plan is stale: durable WAL anchor changed.");
  }
  if (await fingerprintSyncPlan(plan) !== plan.fingerprint) {
    throw new Error("Sync plan fingerprint does not match its immutable contents.");
  }
}
