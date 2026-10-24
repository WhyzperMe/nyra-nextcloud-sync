import { describe, expect, it } from "vitest";
import { AutoSyncScheduler } from "../src/autosync/scheduler";
import { NyraError } from "../src/core/errors";
import type { Logger } from "../src/diagnostics/logger";
import { ServerHealthMonitor } from "../src/health/monitor";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/network/http-client";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const server = "https://cloud.stage9.test";

class StaticTransport implements HttpTransport {
  constructor(private readonly handler: (request: HttpRequest) => Promise<HttpResponse>) {}
  async request(request: HttpRequest): Promise<HttpResponse> { return await this.handler(request); }
}

function response(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  return { status, headers, text, arrayBuffer: bytes.buffer, json: () => payload };
}

function healthyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { installed: true, maintenance: false, needsDbUpgrade: false, version: "35.0.0.0", versionstring: "35.0.0", productname: "Nextcloud", ...overrides };
}

describe("Server health monitor", () => {
  it("classifies maintenance without throwing or changing account state", async () => {
    let now = 1_000_000;
    const monitor = new ServerHealthMonitor(
      new StaticTransport(async () => response(200, healthyPayload({ maintenance: true }))),
      logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 }
    );
    const health = await monitor.checkNow(true);
    expect(health.state).toBe("maintenance");
    expect(health.message).toMatch(/maintenance/i);
    expect(Date.parse(health.nextCheckAt ?? "") - now >= 300_000).toBe(true);
    now += 1;
  });

  it("does not let unauthenticated status.php clear an authenticated credential failure", async () => {
    const monitor = new ServerHealthMonitor(
      new StaticTransport(async () => response(200, healthyPayload())),
      logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => 1_500_000, random: () => 0.5 }
    );
    await monitor.checkNow(true);
    monitor.noteOperationFailure(new NyraError("authentication-rejected", "revoked"));
    expect(monitor.snapshot().state).toBe("auth-required");
    expect((await monitor.checkNow(true)).state).toBe("auth-required");
    monitor.noteOperationSuccess();
    expect(monitor.snapshot().state).toBe("online");
  });

  it("backs off quietly when the server is unreachable", async () => {
    const now = 2_000_000;
    const monitor = new ServerHealthMonitor(
      new StaticTransport(async () => { throw new Error("ECONNREFUSED"); }),
      logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 }
    );
    const health = await monitor.checkNow(true);
    expect(health.state).toBe("offline");
    expect(health.consecutiveFailures).toBe(1);
    expect(Date.parse(health.nextCheckAt ?? "") - now >= 30_000).toBe(true);
  });
});

describe("Quiet-period auto-sync", () => {
  it("preserves edits that arrive while a background cycle is running", async () => {
    const health = new ServerHealthMonitor(
      new StaticTransport(async () => response(200, healthyPayload())),
      logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, random: () => 0.5 }
    );
    await health.checkNow(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 30_000, remotePollMs: 300_000, startupDelayMs: 15_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => { await gate; return { changed: true, executed: true, completedSteps: 1, blockedSteps: 0, reviewItems: 0, bytesProcessed: 1 }; },
      health,
      logger
    });
    const running = scheduler.runNow();
    await Promise.resolve();
    scheduler.noteLocalActivity();
    release();
    await running;
    expect(scheduler.summary().pendingLocalChanges).toBe(1);
    expect(scheduler.summary().status).toBe("waiting-quiet");
    scheduler.close();
  });

  it("never lets the startup/remote poll bypass an active local quiet period", async () => {
    let now = 10_000_000;
    let timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const setTimer = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
      timerId += 1;
      timers.set(timerId, { at: now + ms, callback });
      return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
    };
    const clearTimer = (id: ReturnType<typeof globalThis.setTimeout>): void => { timers.delete(id as unknown as number); };
    const health = new ServerHealthMonitor(
      new StaticTransport(async () => response(200, healthyPayload())), logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 }
    );
    await health.checkNow(true);

    let runs = 0;
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 5_000, remotePollMs: 60_000, startupDelayMs: 1_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => { runs += 1; return { changed: true, executed: true, completedSteps: 1, blockedSteps: 0, reviewItems: 0, bytesProcessed: 1 }; },
      health,
      logger,
      now: () => now,
      setTimer,
      clearTimer
    });
    scheduler.start();
    scheduler.noteLocalActivity();

    await fireEarliest(timers, (value) => { now = value; });
    expect(runs).toBe(0);
    expect(scheduler.summary().status).toBe("waiting-quiet");

    await fireEarliest(timers, (value) => { now = value; });
    expect(runs).toBe(1);
    expect(scheduler.summary().pendingLocalChanges).toBe(0);
    scheduler.close();
  });
});

async function fireEarliest(timers: Map<number, { at: number; callback: () => void }>, setNow: (value: number) => void): Promise<void> {
  const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  if (!next) throw new Error("No timer scheduled.");
  timers.delete(next[0]);
  setNow(next[1].at);
  next[1].callback();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}
