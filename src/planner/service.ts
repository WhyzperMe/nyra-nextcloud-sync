import { errorMessage } from "../core/errors";
import type { Logger } from "../diagnostics/logger";
import { AsyncMutex } from "../state/durable/mutex";
import type { DurableStateStore } from "../state/durable/store";
import { SyncPlanner } from "./planner";
import type { SyncPlan, SyncPlannerRuntimeSummary } from "./types";

export class SyncPlannerService {
  private readonly mutex = new AsyncMutex();
  private readonly planner = new SyncPlanner();
  private lastPlan: SyncPlan | null = null;
  private closed = false;
  private runtime: SyncPlannerRuntimeSummary = {
    status: "idle",
    lastCompletedAt: null,
    lastFingerprint: null,
    stateGeneration: null,
    summary: null,
    lastError: null
  };

  constructor(
    private readonly state: DurableStateStore,
    private readonly logger: Logger,
    private readonly includePath: (path: string) => boolean = () => true
  ) {}

  async buildPlan(): Promise<SyncPlan> {
    return await this.mutex.runExclusive(async () => {
      if (this.closed) throw new Error("Sync planner service is closed.");
      this.runtime.status = "planning";
      this.runtime.lastError = null;
      try {
        const snapshot = this.state.getState();
        const plan = await this.planner.build(snapshot, this.includePath);
        // Ensure state did not advance while hashing/building the plan. A stale
        // plan is never published as current.
        const current = this.state.getState();
        if (current.storeId !== snapshot.storeId || current.generation !== snapshot.generation || current.lastWalHash !== snapshot.lastWalHash) {
          throw new Error("Durable state changed while the sync plan was being built. Rebuild the plan from the new generation.");
        }
        this.lastPlan = plan;
        this.runtime = {
          status: plan.summary.blocked > 0 ? "blocked" : "ready",
          lastCompletedAt: plan.createdAt,
          lastFingerprint: plan.fingerprint,
          stateGeneration: plan.stateGeneration,
          summary: structuredClone(plan.summary),
          lastError: null
        };
        this.logger.info("planner.completed", { generation: plan.stateGeneration, fingerprint: plan.fingerprint.slice(0, 12), ...plan.summary });
        return structuredClone(plan);
      } catch (error) {
        this.runtime.status = "blocked";
        this.runtime.lastError = errorMessage(error);
        this.logger.error("planner.failed", { error: this.runtime.lastError });
        throw error;
      }
    });
  }

  currentPlan(): SyncPlan | null {
    if (!this.lastPlan) return null;
    const current = this.state.getState();
    if (current.storeId !== this.lastPlan.storeId || current.generation !== this.lastPlan.stateGeneration || current.lastWalHash !== this.lastPlan.walHash) return null;
    return structuredClone(this.lastPlan);
  }

  invalidate(reason = "Sync scope changed."): void {
    if (this.closed) return;
    this.lastPlan = null;
    this.runtime.status = "stale";
    this.runtime.lastFingerprint = null;
    this.runtime.stateGeneration = null;
    this.runtime.summary = null;
    this.runtime.lastError = reason;
  }

  summary(): SyncPlannerRuntimeSummary {
    const copy = structuredClone(this.runtime);
    if (!this.closed && this.lastPlan && copy.status !== "planning") {
      const current = this.state.getState();
      if (current.storeId !== this.lastPlan.storeId || current.generation !== this.lastPlan.stateGeneration || current.lastWalHash !== this.lastPlan.walHash) {
        copy.status = "stale";
      }
    }
    return copy;
  }
  close(): void { this.closed = true; this.lastPlan = null; this.runtime.status = "closed"; }
}
