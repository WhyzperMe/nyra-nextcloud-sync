import { describe, expect, it } from "vitest";
import { AutoSyncScheduler } from "../src/autosync/scheduler";
import { ServerHealthMonitor } from "../src/health/monitor";
import type { Logger } from "../src/diagnostics/logger";
import type { AutoSyncTrigger } from "../src/autosync/types";
import { NyraError } from "../src/core/errors";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const result = { changed: false, executed: false, completedSteps: 0, blockedSteps: 0, reviewItems: 0, bytesProcessed: 0 };

function setup(offline = false) {
  let now = Date.parse("2026-10-18T00:00:00Z");
  let nextId = 0;
  let requests = 0;
  let cycleError: Error | null = null;
  const triggers: AutoSyncTrigger[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  const health = new ServerHealthMonitor({ request: async () => {
    requests++;
    if (offline) throw new Error("offline");
    const text = JSON.stringify({ installed: true, maintenance: false, needsDbUpgrade: false, version: "33.0.9.0", versionstring: "33.0.9", productname: "Nextcloud" });
    return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer, json: () => JSON.parse(text) as unknown };
  } }, logger, {
    getServerUrl: () => "https://cloud.test", shouldMonitor: () => true,
    getHealthyIntervalMs: () => 60_000, now: () => now, random: () => 0.5
  });
  const scheduler = new AutoSyncScheduler({
    getPolicy: () => ({ enabled: true, quietPeriodMs: 1_000, remotePollMs: 15_000, startupDelayMs: 1_000, allowDeletes: false }),
    canRun: () => true, isExecutionActive: () => false, health, logger, now: () => now, random: () => 0.5,
    runCycle: async (trigger) => { triggers.push(trigger); if (cycleError) throw cycleError; return result; },
    setTimer: (callback, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimer: (id) => { timers.delete(id as unknown as number); }
  });
  return {
    scheduler, health, triggers, requests: () => requests,
    fail: (value: boolean) => { cycleError = value ? new Error("transient inventory error") : null; },
    failWith: (error: Error | null) => { cycleError = error; },
    nextDelay: () => Date.parse(scheduler.summary().nextRunAt!) - now,
    advance: (ms: number) => { now += ms; },
    fire: async () => {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error("No timer scheduled");
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  };
}

describe("Autosync retry deadlines", () => {
  it("replans promptly after expected contention, with bounded backoff and a reset after success", async () => {
    const c = setup();
    c.failWith(new NyraError("sync-precondition-changed", "Remote ETag changed for HTTP 503.md"));
    c.scheduler.start(); c.scheduler.noteLocalActivity();
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      await c.fire();
      expect(c.nextDelay()).toBe(delay);
      expect(c.health.snapshot().state).toBe("online");
      expect(c.scheduler.summary().pendingLocalChanges).toBe(1);
    }
    c.failWith(null); await c.fire();
    expect(c.scheduler.summary().consecutiveFailures).toBe(0);
    expect(c.scheduler.summary().pendingLocalChanges).toBe(0);
    c.failWith(new NyraError("sync-precondition-changed", "Remote ETag changed again"));
    c.scheduler.noteLocalActivity(); await c.fire();
    expect(c.nextDelay()).toBe(2_000);
    c.scheduler.close(); c.health.close();
  });

  it("never applies the fast contention retry policy to unreliable server conditions", async () => {
    const c = setup();
    c.failWith(new NyraError("remote-precondition-unreliable", "Server accepted a stale ETag"));
    c.scheduler.start(); c.scheduler.noteLocalActivity(); await c.fire();
    expect(c.nextDelay()).toBe(60_000);
    c.advance(100); c.scheduler.noteLocalActivity();
    expect(c.nextDelay()).toBe(59_900);
    c.scheduler.close(); c.health.close();
  });

  it("does not let edit hints or resume bypass offline backoff", async () => {
    const c = setup(true);
    c.scheduler.start();
    await c.fire();
    const retryAt = Date.parse(c.health.snapshot().nextCheckAt!);
    for (let event = 0; event < 20; event++) {
      c.advance(1_000);
      c.scheduler.noteLocalActivity();
      c.scheduler.noteForegroundResume();
      expect(Date.parse(c.scheduler.summary().nextRunAt!)).toBeGreaterThanOrEqual(retryAt);
    }
    expect(c.requests()).toBe(1);
    expect(c.triggers).toHaveLength(0);
    c.scheduler.close();
    c.health.close();
  });

  it("backs off a failed cycle with pending edits and allows an explicit retry", async () => {
    const c = setup();
    c.fail(true);
    c.scheduler.start();
    c.scheduler.noteLocalActivity();
    await c.fire();
    expect(c.triggers).toHaveLength(1);
    const retryAt = Date.parse(c.scheduler.summary().nextRunAt!);
    c.advance(10_000);
    c.scheduler.noteLocalActivity();
    expect(Date.parse(c.scheduler.summary().nextRunAt!)).toBe(retryAt);
    expect(c.scheduler.summary().pendingLocalChanges).toBe(2);
    c.fail(false);
    await c.scheduler.runNow();
    expect(c.triggers).toHaveLength(2);
    expect(c.scheduler.summary().pendingLocalChanges).toBe(0);
    c.scheduler.close();
    c.health.close();
  });

  it("starts a healthy local cycle after one quiet second", async () => {
    const c = setup();
    c.scheduler.start();
    await c.fire();
    c.advance(100);
    const at = Date.parse(c.scheduler.summary().lastRunAt!) + 100;
    c.scheduler.noteLocalActivity();
    expect(Date.parse(c.scheduler.summary().nextRunAt!)).toBe(at + 1_000);
    await c.fire();
    expect(c.triggers).toEqual(["startup", "local-quiet"]);
    c.scheduler.close();
    c.health.close();
  });
});
