import { describe, expect, it } from "vitest";
import { AutoSyncScheduler } from "../src/autosync/scheduler";
import type { AutoSyncPolicy } from "../src/autosync/types";
import { NyraError } from "../src/core/errors";
import type { Logger } from "../src/diagnostics/logger";
import { ServerHealthMonitor } from "../src/health/monitor";
import type { HttpResponse } from "../src/network/http-client";
import { SyncOperationGuard } from "../src/sync/operation-guard";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const result = { changed: false, executed: false, completedSteps: 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function healthy(): HttpResponse {
  const payload = { installed: true, maintenance: false, needsDbUpgrade: false, productname: "Nextcloud", versionstring: "33.0.9" };
  const text = JSON.stringify(payload);
  return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer, json: () => payload };
}
function setup() {
  let server = "https://first.test";
  let ready = true;
  let executionActive = false;
  let now = 1_000_000;
  const requests: Array<{ url: string; gate: ReturnType<typeof deferred<HttpResponse>> }> = [];
  const health = new ServerHealthMonitor({ request: async (input) => {
    const gate = deferred<HttpResponse>();
    requests.push({ url: input.url, gate });
    return await gate.promise;
  } }, logger, { getServerUrl: () => server, shouldMonitor: () => true, getHealthyIntervalMs: () => 60_000, now: () => now });
  const policy: AutoSyncPolicy = { enabled: true, quietPeriodMs: 1_000, remotePollMs: 15_000, startupDelayMs: 1_000, allowDeletes: true };
  const guard = new SyncOperationGuard();
  const runs: boolean[] = [];
  const timers = new Map<number, { callback: () => void; at: number }>();
  let timerId = 0;
  const cycle = deferred<typeof result>();
  let holdCycle = false;
  const scheduler = new AutoSyncScheduler({
    getPolicy: () => policy, canRun: () => ready, isExecutionActive: () => executionActive,
    health, logger, operationGuard: guard, now: () => now, random: () => 0.5,
    runCycle: async (_trigger, allowDeletes) => { runs.push(allowDeletes); return holdCycle ? await cycle.promise : result; },
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, at: now + ms }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (id) => { timers.delete(id as unknown as number); }
  });
  return {
    health, scheduler, policy, guard, runs, requests, timers, cycle,
    setServer: (value: string) => { server = value; },
    setReady: (value: boolean) => { ready = value; },
    setExecutionActive: (value: boolean) => { executionActive = value; },
    holdCycle: () => { holdCycle = true; },
    fire: () => {
      const item = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) throw new Error("Missing timer");
      timers.delete(item[0]); now = item[1].at; item[1].callback();
    },
    close: () => { scheduler.close(); health.close(); }
  };
}
async function settle() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

describe("Settings changes during autosync preflight", () => {
  it("does not start an automatic cycle after disabling autosync during health checking", async () => {
    const c = setup(); c.scheduler.start(); c.fire();
    expect(c.requests).toHaveLength(1);
    c.policy.enabled = false; c.scheduler.reconfigure();
    c.requests[0]!.gate.resolve(healthy()); await settle();
    expect(c.runs).toHaveLength(0);
    expect(c.scheduler.summary().status).toBe("disabled");
    expect(c.guard.isBusy()).toBe(false);
    expect(c.timers.size).toBe(0); c.close();
  });

  it("honors revoked deletion permission without granting new permission mid-flight", async () => {
    for (const initiallyAllowed of [false, true]) {
      const c = setup(); c.policy.allowDeletes = initiallyAllowed;
      const pending = c.scheduler.runNow();
      c.policy.allowDeletes = !initiallyAllowed;
      c.requests[0]!.gate.resolve(healthy()); await pending;
      expect(c.runs).toEqual([false]); c.close();
    }
  });

  it("rechecks account readiness after the asynchronous health check", async () => {
    const c = setup(); const pending = c.scheduler.runNow(); c.setReady(false);
    c.requests[0]!.gate.resolve(healthy()); await pending;
    expect(c.runs).toHaveLength(0); expect(c.guard.isBusy()).toBe(false); c.close();
  });

  it("does not overlap an existing execution even without an acquired scheduler reservation", async () => {
    const c = setup(); c.setExecutionActive(true);
    expect(await c.scheduler.runNow()).toBeNull();
    expect(c.requests).toHaveLength(0); expect(c.runs).toHaveLength(0); c.close();
  });

  it("honors a longer quiet period changed while health is pending", async () => {
    const c = setup(); c.scheduler.start(); c.scheduler.noteLocalActivity(); c.fire();
    c.policy.quietPeriodMs = 30_000; c.scheduler.reconfigure();
    c.requests[0]!.gate.resolve(healthy()); await settle();
    expect(c.runs).toHaveLength(0); expect(c.scheduler.summary().status).toBe("waiting-quiet");
    c.fire(); await settle(); expect(c.runs).toHaveLength(1); c.close();
  });

  it("keeps the scheduler closed when an active cycle finishes or rejects after unload", async () => {
    for (const fails of [false, true]) {
      const c = setup(); c.holdCycle(); const pending = c.scheduler.runNow();
      c.requests[0]!.gate.resolve(healthy()); await settle();
      expect(c.runs).toHaveLength(1); c.scheduler.close();
      if (fails) c.cycle.reject(new Error("late failure")); else c.cycle.resolve(result);
      expect(await pending).toBeNull();
      expect(c.scheduler.summary().status).toBe("closed");
      expect(c.scheduler.summary().lastSuccessAt).toBeNull();
      expect(c.guard.isBusy()).toBe(false); c.close();
    }
  });
});

describe("Health response ownership", () => {
  it("does not let the previous server's delayed success overwrite the new server's state", async () => {
    const c = setup(); const first = c.health.checkNow(true);
    c.setServer("https://second.test"); const second = c.health.checkNow(true);
    expect(c.requests).toHaveLength(2);
    c.requests[1]!.gate.reject(new Error("second offline")); await second;
    c.requests[0]!.gate.resolve(healthy()); await first;
    expect(c.health.snapshot().state).toBe("offline");
    expect(c.health.snapshot().message).toBe("second offline"); c.close();
  });

  it("does not let a delayed failure override newer authenticated success", async () => {
    const c = setup(); const pending = c.health.checkNow(true);
    c.health.noteOperationSuccess(); c.requests[0]!.gate.reject(new Error("stale outage")); await pending;
    expect(c.health.snapshot().state).toBe("online"); expect(c.health.snapshot().consecutiveFailures).toBe(0); c.close();
  });

  it("preserves a newer authenticated failure when an older status request succeeds", async () => {
    const c = setup(); const pending = c.health.checkNow(true);
    c.health.noteOperationFailure(new NyraError("authentication-rejected", "revoked"));
    c.requests[0]!.gate.resolve(healthy()); await pending;
    expect(c.health.snapshot().state).toBe("auth-required"); c.close();
  });

  it("clears the previous server's authentication failure on a server change", async () => {
    const c = setup(); c.health.noteOperationFailure(new NyraError("authentication-rejected", "revoked"));
    c.setServer("https://second.test"); const pending = c.health.checkNow();
    expect(c.requests).toHaveLength(1); c.requests[0]!.gate.resolve(healthy()); await pending;
    expect(c.health.snapshot().state).toBe("online"); c.close();
  });

  it("does not publish a delayed health response after unload", async () => {
    const c = setup(); const pending = c.health.checkNow(true); c.health.close();
    const snapshot = c.health.snapshot(); c.requests[0]!.gate.resolve(healthy()); await pending;
    expect(c.health.snapshot()).toEqual(snapshot); c.close();
  });
});
