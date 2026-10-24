import { NyraError, errorMessage } from "../core/errors";
import type { Logger } from "../diagnostics/logger";
import type { HttpResponse, HttpTransport } from "../network/http-client";
import { nextcloudEndpoints } from "../nextcloud/endpoints";
import { isRecord } from "../nextcloud/ocs";
import { normalizeServerUrl } from "../security/url-policy";
import type { ServerHealthSnapshot, ServerHealthState } from "./types";

const MAX_BACKOFF_MS = 15 * 60_000;
const MIN_FAILURE_BACKOFF_MS = 30_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;

export interface ServerHealthMonitorOptions {
  getServerUrl: () => string;
  shouldMonitor: () => boolean;
  getHealthyIntervalMs: () => number;
  onChange?: (snapshot: ServerHealthSnapshot) => void;
  now?: () => number;
  random?: () => number;
  sleepTimer?: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearSleepTimer?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

/**
 * Lightweight, unauthenticated Nextcloud availability monitor.
 *
 * Expected outages and maintenance are represented as runtime state, not thrown
 * into the UI. The monitor logs only state transitions and uses bounded backoff,
 * so a powered-off server cannot generate a tight request/error loop.
 */
export class ServerHealthMonitor {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleepTimer: NonNullable<ServerHealthMonitorOptions["sleepTimer"]>;
  private readonly clearSleepTimer: NonNullable<ServerHealthMonitorOptions["clearSleepTimer"]>;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private inFlight: { serverUrl: string; promise: Promise<ServerHealthSnapshot> } | null = null;
  private serverScope: string | null = null;
  private operationRevision = 0;
  private authenticatedFailurePending = false;
  private started = false;
  private closed = false;
  private snapshotValue: ServerHealthSnapshot = initialSnapshot();

  constructor(
    private readonly http: HttpTransport,
    private readonly logger: Logger,
    private readonly options: ServerHealthMonitorOptions
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleepTimer = options.sleepTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearSleepTimer = options.clearSleepTimer ?? ((timer) => globalThis.clearTimeout(timer));
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.schedule(500);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    if (this.timer !== null) this.clearSleepTimer(this.timer);
    this.timer = null;
  }

  snapshot(): ServerHealthSnapshot {
    return structuredClone(this.snapshotValue);
  }

  /** Re-evaluates settings/server changes without forcing a request. */
  poke(delayMs = 250): void {
    if (!this.started || this.closed) return;
    this.schedule(delayMs);
  }

  async checkNow(force = false): Promise<ServerHealthSnapshot> {
    if (this.closed) return this.snapshot();
    if (!this.options.shouldMonitor() && !force) {
      this.publish({ ...initialSnapshot(), message: "Connect an account to monitor server availability." });
      this.schedule(this.healthyIntervalMs());
      return this.snapshot();
    }

    const serverUrl = this.refreshServerScope();
    if (!serverUrl) {
      this.publish({ ...initialSnapshot(), message: "Configure a valid Nextcloud server URL." });
      this.schedule(this.healthyIntervalMs());
      return this.snapshot();
    }

    const now = this.now();
    const nextCheck = parseTimestamp(this.snapshotValue.nextCheckAt);
    if (!force && nextCheck !== null && now < nextCheck) return this.snapshot();
    if (this.inFlight?.serverUrl === serverUrl) return await this.inFlight.promise;

    const pending = { serverUrl, promise: this.performCheck(serverUrl, this.operationRevision) };
    this.inFlight = pending;
    try { return await pending.promise; }
    finally { if (this.inFlight === pending) this.inFlight = null; }
  }

  /** Allows failed authenticated/WebDAV operations to immediately influence backoff. */
  noteOperationFailure(error: unknown): void {
    if (this.closed) return;
    const classification = classifyExternalFailure(error);
    if (!classification) return;
    this.refreshServerScope();
    this.operationRevision += 1;
    if (classification.state === "auth-required") this.authenticatedFailurePending = true;
    this.recordFailure(classification.state, classification.message, null);
  }

  /** A successful authenticated sync operation is stronger evidence than a stale health sample. */
  noteOperationSuccess(): void {
    if (this.closed) return;
    this.refreshServerScope();
    this.operationRevision += 1;
    this.authenticatedFailurePending = false;
    const now = this.now();
    this.publish({
      ...this.snapshotValue,
      state: "online",
      checkedAt: iso(now),
      lastOnlineAt: iso(now),
      nextCheckAt: iso(now + this.healthyIntervalMs()),
      consecutiveFailures: 0,
      message: "Nextcloud is reachable."
    });
    this.schedule(this.healthyIntervalMs());
  }

  private async performCheck(serverUrl: string, operationRevision: number): Promise<ServerHealthSnapshot> {
    const isCurrent = () => !this.closed && this.safeServerUrl() === serverUrl && this.operationRevision === operationRevision;
    const previousState = this.snapshotValue.state;
    const authFailurePending = this.authenticatedFailurePending || previousState === "auth-required";
    if (authFailurePending) this.authenticatedFailurePending = true;
    this.publish({
      ...this.snapshotValue,
      state: authFailurePending ? "auth-required" : "checking",
      message: authFailurePending ? "Checking Nextcloud availability; authentication still needs attention." : "Checking Nextcloud…"
    }, false);
    try {
      const response = await this.http.request({
        url: nextcloudEndpoints.status(serverUrl),
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: 10_000
      });
      if (!isCurrent()) return this.snapshot();
      this.consumeStatusResponse(response);
    } catch (error) {
      if (!isCurrent()) return this.snapshot();
      this.recordFailure("offline", conciseNetworkMessage(error), null);
    }

    if (previousState !== this.snapshotValue.state) {
      this.logger.info("health.state-changed", {
        from: previousState,
        to: this.snapshotValue.state,
        nextCheckAt: this.snapshotValue.nextCheckAt
      });
    }
    return this.snapshot();
  }

  private consumeStatusResponse(response: HttpResponse): void {
    if (response.status === 429) {
      this.recordFailure("degraded", "Nextcloud is throttling requests. Auto-sync will retry later.", retryAfterMs(response, this.now()));
      return;
    }
    if (response.status >= 500) {
      this.recordFailure("degraded", `Nextcloud is temporarily unavailable (HTTP ${response.status}).`, retryAfterMs(response, this.now()));
      return;
    }
    if (response.status !== 200) {
      this.recordFailure("degraded", `Nextcloud status check returned HTTP ${response.status}.`, retryAfterMs(response, this.now()));
      return;
    }

    let raw: unknown;
    try { raw = response.json(); }
    catch {
      this.recordFailure("degraded", "Nextcloud returned an invalid status response.", null);
      return;
    }
    if (!isRecord(raw)) {
      this.recordFailure("degraded", "Nextcloud returned an invalid status response.", null);
      return;
    }

    const installed = raw.installed === true;
    const maintenance = raw.maintenance === true;
    const needsDbUpgrade = raw.needsDbUpgrade === true;
    const productName = typeof raw.productname === "string" ? raw.productname : "";
    const versionString = typeof raw.versionstring === "string" ? raw.versionstring : null;

    if (!installed || !productName.toLowerCase().includes("nextcloud")) {
      this.recordFailure("degraded", "The configured endpoint is not reporting a healthy Nextcloud installation.", null);
      return;
    }
    if (maintenance || needsDbUpgrade) {
      this.recordFailure(
        "maintenance",
        needsDbUpgrade ? "Nextcloud requires a database upgrade. Auto-sync is paused." : "Nextcloud is in maintenance mode. Auto-sync is paused.",
        MAINTENANCE_RECHECK_MS,
        versionString
      );
      return;
    }

    const now = this.now();
    // status.php proves server availability, not credential validity. Once an
    // authenticated operation has established auth-required, only a successful
    // authenticated verification/operation may clear that state.
    if (this.authenticatedFailurePending || this.snapshotValue.state === "auth-required") {
      this.authenticatedFailurePending = true;
      this.publish({
        ...this.snapshotValue,
        checkedAt: iso(now),
        nextCheckAt: iso(now + this.healthyIntervalMs()),
        serverVersionString: versionString,
        message: "Nextcloud is online, but authentication needs attention."
      });
      this.schedule(this.healthyIntervalMs());
      return;
    }
    this.publish({
      state: "online",
      checkedAt: iso(now),
      nextCheckAt: iso(now + this.healthyIntervalMs()),
      lastOnlineAt: iso(now),
      consecutiveFailures: 0,
      message: "Nextcloud is reachable.",
      serverVersionString: versionString
    });
    this.schedule(this.healthyIntervalMs());
  }

  private recordFailure(
    state: Exclude<ServerHealthState, "unknown" | "checking" | "online">,
    message: string,
    requestedDelayMs: number | null,
    serverVersionString: string | null = this.snapshotValue.serverVersionString
  ): void {
    const now = this.now();
    const failures = this.snapshotValue.consecutiveFailures + 1;
    const delay = state === "maintenance"
      ? Math.max(MAINTENANCE_RECHECK_MS, requestedDelayMs ?? 0)
      : Math.max(requestedDelayMs ?? 0, this.failureBackoffMs(failures));
    this.publish({
      state,
      checkedAt: iso(now),
      nextCheckAt: iso(now + delay),
      lastOnlineAt: this.snapshotValue.lastOnlineAt,
      consecutiveFailures: failures,
      message,
      serverVersionString
    });
    this.schedule(delay);
  }

  private publish(next: ServerHealthSnapshot, notify = true): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.snapshotValue);
    this.snapshotValue = next;
    if (changed && notify) this.options.onChange?.(this.snapshot());
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.closed) return;
    if (this.timer !== null) this.clearSleepTimer(this.timer);
    const safeDelay = Math.max(250, Math.min(MAX_BACKOFF_MS, Math.round(delayMs)));
    this.timer = this.sleepTimer(() => {
      this.timer = null;
      void this.checkNow(false).finally(() => {
        // checkNow normally schedules the next wake. If it returned early because
        // monitoring is disabled, make sure the monitor still re-evaluates later.
        if (this.started && !this.closed && this.timer === null) this.schedule(this.healthyIntervalMs());
      });
    }, safeDelay);
  }

  private failureBackoffMs(failures: number): number {
    const exponential = Math.min(MAX_BACKOFF_MS, MIN_FAILURE_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
    const jitter = 0.9 + this.random() * 0.2;
    return Math.max(MIN_FAILURE_BACKOFF_MS, Math.round(exponential * jitter));
  }

  private healthyIntervalMs(): number {
    const value = this.options.getHealthyIntervalMs();
    return Number.isFinite(value) ? Math.max(30_000, Math.min(15 * 60_000, Math.round(value))) : 60_000;
  }

  private safeServerUrl(): string | null {
    try {
      const raw = this.options.getServerUrl();
      return raw ? normalizeServerUrl(raw) : null;
    } catch { return null; }
  }

  private refreshServerScope(): string | null {
    const serverUrl = this.safeServerUrl();
    if (serverUrl !== this.serverScope) {
      this.serverScope = serverUrl;
      this.operationRevision += 1;
      this.authenticatedFailurePending = false;
      this.publish(initialSnapshot());
    }
    return serverUrl;
  }
}

function initialSnapshot(): ServerHealthSnapshot {
  return {
    state: "unknown",
    checkedAt: null,
    nextCheckAt: null,
    lastOnlineAt: null,
    consecutiveFailures: 0,
    message: "Server status has not been checked yet.",
    serverVersionString: null
  };
}

function classifyExternalFailure(error: unknown): { state: "offline" | "maintenance" | "degraded" | "auth-required"; message: string } | null {
  if (error instanceof NyraError) {
    if (error.code === "sync-precondition-changed" || error.code === "remote-precondition-unreliable") return null;
    if (error.code === "network-error") return { state: "offline", message: "Nextcloud is unreachable. Auto-sync will retry quietly." };
    if (error.code === "maintenance-mode") return { state: "maintenance", message: "Nextcloud maintenance is active. Auto-sync is paused." };
    if (error.code === "authentication-rejected" || error.code === "missing-credentials" || error.code === "credential-server-mismatch") {
      return { state: "auth-required", message: "Nextcloud authentication needs attention. Auto-sync is paused." };
    }
  }
  const message = errorMessage(error);
  if (/\b(?:HTTP\s*)?(?:423|425|429|500|502|503|504)\b/i.test(message)) {
    return { state: "degraded", message: "Nextcloud is temporarily busy or unavailable. Auto-sync will retry later." };
  }
  return null;
}

function conciseNetworkMessage(error: unknown): string {
  if (error instanceof NyraError && error.code === "network-error") return "Nextcloud is unreachable. Auto-sync will retry quietly.";
  const message = errorMessage(error);
  return message.length > 160 ? `${message.slice(0, 157)}…` : message;
}

function retryAfterMs(response: HttpResponse, nowMs: number): number | null {
  const raw = headerValue(response.headers, "retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_BACKOFF_MS, Math.max(1_000, seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(MAX_BACKOFF_MS, Math.max(1_000, date - nowMs));
  return null;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === needle) return value;
  return null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
