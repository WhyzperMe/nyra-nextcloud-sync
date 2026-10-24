import { describe, expect, it } from "vitest";
import { AutoSyncScheduler } from "../src/autosync/scheduler";
import { NyraError } from "../src/core/errors";
import type { Logger } from "../src/diagnostics/logger";
import { ServerHealthMonitor } from "../src/health/monitor";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/network/http-client";
import { SyncOperationGuard } from "../src/sync/operation-guard";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const server = "https://cloud.autosync.test";

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

describe("Auto-sync regression server health monitor", () => {
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

describe("Auto-sync regression quiet-period auto-sync", () => {
  it("coalesces a 100-event edit burst into one cycle at the quiet deadline", async () => {
    let now = 1_000_000;
    let timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const setTimer = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
      timerId += 1;
      timers.set(timerId, { at: now + ms, callback });
      return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
    };
    const clearTimer = (id: ReturnType<typeof globalThis.setTimeout>): void => { timers.delete(id as unknown as number); };
    const health = new ServerHealthMonitor(new StaticTransport(async () => response(200, healthyPayload())), logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 });
    await health.checkNow(true);
    let cycles = 0;
    let cycleStartedAt = -1;
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 1_000, remotePollMs: 15_000, startupDelayMs: 60_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => {
        cycles += 1;
        cycleStartedAt = now;
        return { changed: false, executed: false, completedSteps: 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 };
      },
      health, logger, now: () => now, setTimer, clearTimer
    });
    scheduler.start();
    for (let event = 0; event < 100; event += 1) {
      now += 10;
      scheduler.noteLocalActivity();
    }
    const finalEditAt = now;
    expect(scheduler.summary().pendingLocalChanges).toBe(100);
    await fireEarliest(timers, (value) => { now = value; });
    expect(cycles).toBe(1);
    expect(cycleStartedAt - finalEditAt).toBe(1_000);
    expect(scheduler.summary().pendingLocalChanges).toBe(0);
    scheduler.close();
    health.close();
  });

  it("reserves the health-check preflight so manual requests cannot start overlapping cycles", async () => {
    let releaseHealth!: () => void;
    let markHealthStarted!: () => void;
    const healthStarted = new Promise<void>((resolve) => { markHealthStarted = resolve; });
    const healthGate = new Promise<void>((resolve) => { releaseHealth = resolve; });
    const health = new ServerHealthMonitor(
      new StaticTransport(async () => {
        markHealthStarted();
        await healthGate;
        return response(200, healthyPayload());
      }), logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000 }
    );
    const operationGuard = new SyncOperationGuard();
    let runs = 0;
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 30_000, remotePollMs: 300_000, startupDelayMs: 15_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => { runs += 1; return { changed: true, executed: true, completedSteps: 1, blockedSteps: 0, reviewItems: 0, bytesProcessed: 1 }; },
      health,
      logger,
      operationGuard
    });

    const first = scheduler.runNow();
    await healthStarted;
    expect(operationGuard.currentOwner()).toBe("autosync");
    expect(operationGuard.tryAcquire("manual")).toBeNull();
    expect(await scheduler.runNow()).toBeNull();
    releaseHealth();
    const result = await first;
    expect(result?.executed).toBe(true);
    expect(runs).toBe(1);
    expect(operationGuard.isBusy()).toBe(false);
    scheduler.close();
  });

  it("restarts the quiet window when an edit arrives during health preflight", async () => {
    let now = 5_000_000;
    let releaseHealth!: () => void;
    let markHealthStarted!: () => void;
    const healthStarted = new Promise<void>((resolve) => { markHealthStarted = resolve; });
    const healthGate = new Promise<void>((resolve) => { releaseHealth = resolve; });
    let timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const setTimer = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
      timerId += 1;
      timers.set(timerId, { at: now + ms, callback });
      return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
    };
    const clearTimer = (id: ReturnType<typeof globalThis.setTimeout>): void => { timers.delete(id as unknown as number); };
    const health = new ServerHealthMonitor(new StaticTransport(async () => {
      markHealthStarted();
      await healthGate;
      return response(200, healthyPayload());
    }), logger, { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now });
    let runs = 0;
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 5_000, remotePollMs: 15_000, startupDelayMs: 1_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => { runs += 1; return { changed: false, executed: false, completedSteps: 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 }; },
      health, logger, now: () => now, setTimer, clearTimer
    });
    scheduler.start();
    const first = fireEarliest(timers, (value) => { now = value; });
    await healthStarted;
    scheduler.noteLocalActivity();
    releaseHealth();
    await first;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    expect(runs).toBe(0);
    expect(scheduler.summary().status).toBe("waiting-quiet");
    await fireEarliest(timers, (value) => { now = value; });
    expect(runs).toBe(1);
    scheduler.close();
  });

  it("backs off unchanged remote scans and resets to the fast interval after work", async () => {
    let now = 9_000_000;
    let didWork = false;
    let timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const setTimer = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
      timerId += 1;
      timers.set(timerId, { at: now + ms, callback });
      return timerId as unknown as ReturnType<typeof globalThis.setTimeout>;
    };
    const clearTimer = (id: ReturnType<typeof globalThis.setTimeout>): void => { timers.delete(id as unknown as number); };
    const health = new ServerHealthMonitor(new StaticTransport(async () => response(200, healthyPayload())), logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5 });
    await health.checkNow(true);
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 1_000, remotePollMs: 15_000, startupDelayMs: 1_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => ({ changed: didWork, executed: didWork, completedSteps: didWork ? 1 : 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 }),
      health, logger, now: () => now, random: () => 0.5, setTimer, clearTimer
    });
    scheduler.start();
    await scheduler.runNow();
    expect(Date.parse(scheduler.summary().nextRemotePollAt ?? "") - now).toBe(30_000);
    await scheduler.runNow();
    expect(Date.parse(scheduler.summary().nextRemotePollAt ?? "") - now).toBe(60_000);
    didWork = true;
    await scheduler.runNow();
    expect(Date.parse(scheduler.summary().nextRemotePollAt ?? "") - now).toBe(15_000);
    scheduler.close();
  });

  it("jitters startup discovery so devices do not all poll on the same instant", () => {
    const health = new ServerHealthMonitor(new StaticTransport(async () => response(200, healthyPayload())), logger,
      { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => 1_000_000 });
    const makeScheduler = (random: () => number) => new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 1_000, remotePollMs: 15_000, startupDelayMs: 15_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async () => ({ changed: false, executed: false, completedSteps: 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 }),
      health, logger, now: () => 1_000_000, random
    });
    const low = makeScheduler(() => 0);
    const high = makeScheduler(() => 1);
    low.start();
    high.start();
    expect(Date.parse(low.summary().nextRemotePollAt ?? "") - 1_000_000).toBe(13_500);
    expect(Date.parse(high.summary().nextRemotePollAt ?? "") - 1_000_000).toBe(16_500);
    low.close();
    high.close();
    health.close();
  });

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

  it("makes remote discovery immediately eligible after mobile foreground resume without bypassing local quiescence", async () => {
    let now = 20_000_000;
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

    const triggers: string[] = [];
    const scheduler = new AutoSyncScheduler({
      getPolicy: () => ({ enabled: true, quietPeriodMs: 5_000, remotePollMs: 300_000, startupDelayMs: 60_000, allowDeletes: false }),
      canRun: () => true,
      isExecutionActive: () => false,
      runCycle: async (trigger) => { triggers.push(trigger); return { changed: false, executed: false, completedSteps: 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 }; },
      health,
      logger,
      now: () => now,
      setTimer,
      clearTimer
    });
    scheduler.start();
    scheduler.noteForegroundResume();
    await fireEarliest(timers, (value) => { now = value; });
    expect(triggers).toEqual(["foreground-resume"]);

    scheduler.noteLocalActivity();
    scheduler.noteForegroundResume();
    await fireEarliest(timers, (value) => { now = value; });
    expect(triggers.length).toBe(1);
    expect(scheduler.summary().status).toBe("waiting-quiet");
    await fireEarliest(timers, (value) => { now = value; });
    expect(triggers.length).toBe(2);
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
