import { NyraError, errorMessage } from "../core/errors";
import type { Logger } from "../diagnostics/logger";
import type { ServerHealthMonitor } from "../health/monitor";
import type { AutoSyncCycleResult, AutoSyncPolicy, AutoSyncRuntimeSummary, AutoSyncTrigger } from "./types";
import type { SyncOperationGuard } from "../sync/operation-guard";

const BUSY_RETRY_MS = 5_000;
const INTERNAL_ERROR_RETRY_MS = 60_000;
const REPLAN_RETRY_MS = 2_000;

export interface AutoSyncSchedulerOptions {
  getPolicy: () => AutoSyncPolicy;
  canRun: () => boolean;
  isExecutionActive: () => boolean;
  runCycle: (trigger: AutoSyncTrigger, allowDeletes: boolean) => Promise<AutoSyncCycleResult>;
  health: ServerHealthMonitor;
  logger: Logger;
  operationGuard?: SyncOperationGuard;
  onChange?: (summary: AutoSyncRuntimeSummary) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimer?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

/**
 * Quiet-period autosync scheduler.
 *
 * It never executes directly from a file event. Events only move a deadline.
 * The actual cycle runs after the vault has been quiet for the configured period,
 * re-checks server health, performs fresh inventories/planning, and then invokes
 * the transactional executor. One timer and one cycle owner prevent overlap.
 */
export class AutoSyncScheduler {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: NonNullable<AutoSyncSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AutoSyncSchedulerOptions["clearTimer"]>;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private started = false;
  private closed = false;
  private running = false;
  private attempting = false;
  private activityRevision = 0;
  private localDueAt: number | null = null;
  private foregroundResumePending = false;
  private nextRemotePollAtMs: number | null = null;
  private adaptiveRemotePollMs: number | null = null;
  private retryNotBeforeMs = 0;
  private runtime: AutoSyncRuntimeSummary = initialRuntime();

  constructor(private readonly options: AutoSyncSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    const policy = this.normalizedPolicy();
    const now = this.now();
    this.adaptiveRemotePollMs = policy.remotePollMs;
    this.nextRemotePollAtMs = now + this.jitter(policy.startupDelayMs);
    this.refreshEnabledState();
    this.scheduleNext();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.runtime.status = "closed";
    this.publish();
  }

  summary(): AutoSyncRuntimeSummary { return structuredClone(this.runtime); }

  /** Covers the asynchronous health preflight as well as an executing cycle. */
  isBusy(): boolean { return this.attempting || this.running; }

  reconfigure(): void {
    if (this.closed) return;
    const policy = this.normalizedPolicy();
    const now = this.now();
    if (!policy.enabled) {
      this.localDueAt = null;
      this.nextRemotePollAtMs = null;
      this.runtime.pendingLocalChanges = 0;
      this.runtime.nextRunAt = null;
      this.runtime.nextRemotePollAt = null;
      this.runtime.status = "disabled";
    } else {
      this.adaptiveRemotePollMs = policy.remotePollMs;
      if (this.nextRemotePollAtMs === null) this.nextRemotePollAtMs = now + this.jitter(policy.startupDelayMs);
      if (this.runtime.pendingLocalChanges > 0 && this.runtime.lastLocalActivityAt) {
        const last = Date.parse(this.runtime.lastLocalActivityAt);
        this.localDueAt = Number.isFinite(last) ? last + policy.quietPeriodMs : now + policy.quietPeriodMs;
      }
      if (!this.running && this.runtime.status === "disabled") this.runtime.status = this.localDueAt ? "waiting-quiet" : "idle";
    }
    this.publish();
    this.scheduleNext();
  }

  noteLocalActivity(): void {
    if (this.closed) return;
    this.activityRevision += 1;
    const policy = this.normalizedPolicy();
    if (!policy.enabled) return;
    const now = this.now();
    this.runtime.pendingLocalChanges += 1;
    this.runtime.lastLocalActivityAt = iso(now);
    this.localDueAt = now + policy.quietPeriodMs;
    if (!this.running) this.runtime.status = "waiting-quiet";
    this.publish();
    this.scheduleNext();
  }

  /**
   * iOS can suspend JavaScript timers while Obsidian is backgrounded. When the
   * app becomes visible again, make remote discovery immediately eligible while
   * still respecting any active local quiet-period deadline.
   */
  noteForegroundResume(): void {
    if (this.closed || !this.started) return;
    const policy = this.normalizedPolicy();
    if (!policy.enabled) return;
    const now = this.now();
    this.nextRemotePollAtMs = now;
    this.foregroundResumePending = true;
    if (!this.running && this.localDueAt === null) this.runtime.status = "idle";
    this.publish();
    this.scheduleNext();
  }

  async runNow(): Promise<AutoSyncCycleResult | null> {
    if (this.closed) return null;
    return await this.tryRun("manual", true);
  }

  private async wake(): Promise<void> {
    if (this.closed || !this.started) return;
    this.timer = null;
    const policy = this.normalizedPolicy();
    if (!policy.enabled) {
      this.refreshEnabledState();
      return;
    }
    if (this.running || this.attempting || this.options.isExecutionActive()) {
      this.scheduleAt(this.now() + BUSY_RETRY_MS);
      return;
    }

    const now = this.now();
    if (now < this.retryNotBeforeMs) {
      this.scheduleAt(this.retryNotBeforeMs);
      return;
    }
    const localDue = this.localDueAt !== null && now >= this.localDueAt;
    const remoteDue = this.nextRemotePollAtMs !== null && now >= this.nextRemotePollAtMs;

    // A remote poll must never bypass local quiescence. If the user is actively
    // editing, the periodic poll waits for the same quiet deadline instead of
    // building a plan from a moving local target.
    if (remoteDue && this.localDueAt !== null && !localDue) {
      this.runtime.status = "waiting-quiet";
      this.publish();
      this.scheduleAt(this.localDueAt);
      return;
    }
    if (!localDue && !remoteDue) {
      this.scheduleNext();
      return;
    }

    const trigger: AutoSyncTrigger = localDue
      ? "local-quiet"
      : this.foregroundResumePending
        ? "foreground-resume"
        : (this.runtime.lastRunAt === null ? "startup" : "remote-poll");
    this.foregroundResumePending = false;
    await this.tryRun(trigger, false);
  }

  private async tryRun(trigger: AutoSyncTrigger, force: boolean): Promise<AutoSyncCycleResult | null> {
    const policy = this.normalizedPolicy();
    if ((!policy.enabled && !force) || this.running || this.attempting || this.closed) return null;
    if (this.options.isExecutionActive()) {
      this.scheduleAt(this.now() + BUSY_RETRY_MS);
      return null;
    }
    const releaseOperation = this.options.operationGuard?.tryAcquire("autosync") ?? null;
    if (this.options.operationGuard && !releaseOperation) {
      this.scheduleAt(this.now() + BUSY_RETRY_MS);
      return null;
    }
    // Reserve the entire preflight, including the asynchronous health check. A
    // timer wake and a manual request can otherwise both pass the running check
    // and start duplicate inventory/execution cycles.
    this.attempting = true;
    const startedRevision = this.activityRevision;
    try {
      if (!this.options.canRun()) {
        this.runtime.status = "waiting-health";
        this.runtime.lastError = null;
        this.publish();
        this.retryNotBeforeMs = this.now() + Math.min(policy.remotePollMs, 5 * 60_000);
        this.scheduleAt(this.retryNotBeforeMs);
        return null;
      }

      const health = await this.options.health.checkNow(force);
      if (this.closed) return null;
      // Settings and account readiness can change while status.php is in flight.
      // A revoked permission must take effect before entering the write cycle.
      const currentPolicy = this.normalizedPolicy();
      if (!force && !currentPolicy.enabled) {
        this.refreshEnabledState();
        return null;
      }
      if (!this.options.canRun() || this.options.isExecutionActive()) {
        this.runtime.status = "waiting-health";
        this.scheduleAt(this.now() + BUSY_RETRY_MS);
        return null;
      }
      if (health.state !== "online") {
        this.runtime.status = "waiting-health";
        this.runtime.lastError = null;
        this.publish();
        const next = health.nextCheckAt ? Date.parse(health.nextCheckAt) : this.now() + 30_000;
        this.retryNotBeforeMs = Number.isFinite(next) ? next : this.now() + 30_000;
        this.scheduleAt(this.retryNotBeforeMs);
        return null;
      }

      // A local edit during the health request invalidates the quiet-period
      // preflight. Wait for the newer deadline instead of scanning a moving vault.
      const lastActivity = this.runtime.lastLocalActivityAt ? Date.parse(this.runtime.lastLocalActivityAt) : NaN;
      if (!force && (startedRevision !== this.activityRevision ||
        (this.localDueAt !== null && Number.isFinite(lastActivity) && this.now() < lastActivity + currentPolicy.quietPeriodMs))) {
        const last = this.runtime.lastLocalActivityAt ? Date.parse(this.runtime.lastLocalActivityAt) : this.now();
        this.localDueAt = (Number.isFinite(last) ? last : this.now()) + currentPolicy.quietPeriodMs;
        this.runtime.status = "waiting-quiet";
        this.publish();
        this.scheduleAt(this.localDueAt);
        return null;
      }

      this.running = true;
      this.retryNotBeforeMs = 0;
      this.runtime.status = "syncing";
      this.runtime.lastTrigger = trigger;
      this.runtime.lastRunAt = iso(this.now());
      this.runtime.lastError = null;
      this.publish();

      const result = await this.options.runCycle(trigger, policy.allowDeletes && currentPolicy.allowDeletes);
      if (this.closed) return null;
      this.options.health.noteOperationSuccess();
      this.runtime.lastSuccessAt = iso(this.now());
      this.runtime.lastResult = structuredClone(result);
      this.runtime.consecutiveFailures = 0;
      this.runtime.lastError = null;
      this.runtime.status = result.reviewItems > 0 || result.blockedSteps > 0 ? "attention" : "idle";

      if (startedRevision === this.activityRevision) {
        this.runtime.pendingLocalChanges = 0;
        this.localDueAt = null;
      } else if (this.runtime.lastLocalActivityAt) {
        const last = Date.parse(this.runtime.lastLocalActivityAt);
        this.localDueAt = (Number.isFinite(last) ? last : this.now()) + policy.quietPeriodMs;
        this.runtime.status = "waiting-quiet";
      }
      const maximumPoll = Math.max(policy.remotePollMs, Math.min(5 * 60_000, policy.remotePollMs * 8));
      const currentPoll = this.adaptiveRemotePollMs ?? policy.remotePollMs;
      this.adaptiveRemotePollMs = result.executed || result.completedSteps > 0
        ? policy.remotePollMs
        : Math.min(maximumPoll, currentPoll * 2);
      this.nextRemotePollAtMs = this.now() + this.jitterWithin(this.adaptiveRemotePollMs, policy.remotePollMs, maximumPoll);
      this.options.logger.info("autosync.cycle-completed", {
        trigger,
        executed: result.executed,
        completedSteps: result.completedSteps,
        reviewItems: result.reviewItems,
        bytesProcessed: result.bytesProcessed
      });
      return structuredClone(result);
    } catch (error) {
      if (this.closed) return null;
      this.options.health.noteOperationFailure(error);
      const healthAfter = this.options.health.snapshot();
      this.runtime.consecutiveFailures += 1;
      this.runtime.lastError = concise(error);
      this.runtime.status = healthAfter.state === "online" ? "error" : "waiting-health";
      if (healthAfter.state === "online") {
        const needsReplan = error instanceof NyraError && error.code === "sync-precondition-changed";
        const delay = needsReplan
          ? Math.min(INTERNAL_ERROR_RETRY_MS, REPLAN_RETRY_MS * 2 ** Math.min(5, this.runtime.consecutiveFailures - 1))
          : INTERNAL_ERROR_RETRY_MS;
        this.retryNotBeforeMs = this.now() + this.jitter(delay);
        this.nextRemotePollAtMs = this.retryNotBeforeMs;
        if (needsReplan) this.options.logger.debug("autosync.replan-scheduled", { trigger, delay });
        else this.options.logger.warn("autosync.cycle-failed", { trigger, error: this.runtime.lastError });
      } else {
        const next = healthAfter.nextCheckAt ? Date.parse(healthAfter.nextCheckAt) : NaN;
        this.retryNotBeforeMs = Number.isFinite(next) ? Math.max(this.now() + 1_000, next) : this.now() + 30_000;
      }
      return null;
    } finally {
      const cycleWasRunning = this.running;
      this.running = false;
      this.attempting = false;
      releaseOperation?.();
      if (!this.closed) {
        this.publish();
        if (cycleWasRunning || this.timer === null) this.scheduleNext();
      }
    }
  }

  private refreshEnabledState(): void {
    const enabled = this.normalizedPolicy().enabled;
    this.runtime.enabled = enabled;
    if (!enabled && !this.running) this.runtime.status = "disabled";
    else if (enabled && this.runtime.status === "disabled") this.runtime.status = this.localDueAt ? "waiting-quiet" : "idle";
    this.publish();
  }

  private scheduleNext(): void {
    if (!this.started || this.closed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const policy = this.normalizedPolicy();
    this.runtime.enabled = policy.enabled;
    if (!policy.enabled) {
      this.runtime.status = "disabled";
      this.runtime.nextRunAt = null;
      this.runtime.nextRemotePollAt = null;
      this.publish();
      return;
    }

    const candidates: number[] = [];
    if (this.localDueAt !== null) candidates.push(this.localDueAt);
    if (this.nextRemotePollAtMs !== null) candidates.push(this.nextRemotePollAtMs);
    const health = this.options.health.snapshot();
    if (health.state !== "online" && health.nextCheckAt) {
      const healthAt = Date.parse(health.nextCheckAt);
      if (Number.isFinite(healthAt)) candidates.push(healthAt);
    }
    if (candidates.length === 0) {
      const maximumPoll = Math.max(policy.remotePollMs, Math.min(5 * 60_000, policy.remotePollMs * 8));
      this.nextRemotePollAtMs = this.now() + this.jitterWithin(policy.remotePollMs, policy.remotePollMs, maximumPoll);
      candidates.push(this.nextRemotePollAtMs);
    }
    // New edit hints must not cancel offline/throttle/error backoff.
    const next = Math.max(this.now() + 50, this.retryNotBeforeMs, Math.min(...candidates));
    this.runtime.nextRunAt = iso(next);
    this.runtime.nextRemotePollAt = this.nextRemotePollAtMs === null ? null : iso(this.nextRemotePollAtMs);
    if (!this.running && this.localDueAt !== null && this.now() >= this.retryNotBeforeMs) this.runtime.status = "waiting-quiet";
    this.publish();
    this.scheduleAt(next);
  }

  private scheduleAt(atMs: number): void {
    if (!this.started || this.closed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    const delay = Math.max(50, Math.min(2_147_000_000, Math.round(atMs - this.now())));
    this.timer = this.setTimer(() => { void this.wake(); }, delay);
    this.runtime.nextRunAt = iso(this.now() + delay);
    this.publish();
  }

  private normalizedPolicy(): AutoSyncPolicy {
    const raw = this.options.getPolicy();
    return {
      enabled: raw.enabled,
      quietPeriodMs: clamp(raw.quietPeriodMs, 750, 10 * 60_000),
      remotePollMs: clamp(raw.remotePollMs, 15_000, 60 * 60_000),
      startupDelayMs: clamp(raw.startupDelayMs, 1_000, 5 * 60_000),
      allowDeletes: raw.allowDeletes
    };
  }

  private jitter(baseMs: number): number {
    const sample = this.random();
    const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
    return Math.max(1_000, Math.round(baseMs * (0.9 + normalized * 0.2)));
  }

  private jitterWithin(baseMs: number, minimumMs: number, maximumMs: number): number {
    return Math.max(minimumMs, Math.min(maximumMs, this.jitter(baseMs)));
  }

  private publish(): void { this.options.onChange?.(this.summary()); }
}

function initialRuntime(): AutoSyncRuntimeSummary {
  return {
    enabled: false,
    status: "disabled",
    pendingLocalChanges: 0,
    lastLocalActivityAt: null,
    nextRunAt: null,
    nextRemotePollAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastTrigger: null,
    lastResult: null,
    consecutiveFailures: 0,
    lastError: null
  };
}
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function concise(error: unknown): string {
  const message = errorMessage(error);
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
}
