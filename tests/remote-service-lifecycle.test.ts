import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { NextcloudDavClient } from "../src/remote/dav-client";
import { RemoteInventoryReconciler } from "../src/remote/reconciler";
import { RemoteInventoryScanner } from "../src/remote/scanner";
import { RemoteInventoryService } from "../src/remote/service";
import { DurableStateStore } from "../src/state/durable/store";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const serverUrl = "https://cloud.example.test";
const root = `${serverUrl}/remote.php/dav/files/alice/`;

describe("Remote inventory lifecycle", () => {
  it("invalidates completeness after a later pre-reconciliation failure", async () => {
    const dav = new FakeNextcloudDav(serverUrl, "alice");
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const scanner = new RemoteInventoryScanner(new NextcloudDavClient(dav, { serverUrl, loginName: "alice", appPassword: "fixture" }, logger), root, logger);
    let fail = false;
    const service = new RemoteInventoryService(scanner, new RemoteInventoryReconciler(store), store, logger, undefined,
      async () => { if (fail) throw new Error("Root mapping could not be proven"); });
    await service.scanFull("Obsidian");
    expect(service.summary().lastScanComplete).toBe(true);
    fail = true;
    await expect(service.scanFull("Obsidian")).rejects.toThrow(/Root mapping/);
    expect(service.summary().lastScanComplete).toBe(false);
    expect(service.summary().status).toBe("degraded");
    service.close(); await store.close();
  });

  it("does not reconcile a delayed scan after the service closes", async () => {
    const dav = new FakeNextcloudDav(serverUrl, "alice");
    await dav.request({ url: `${root}Obsidian/new.md`, method: "PUT", body: "new" });
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const scanner = new RemoteInventoryScanner(new NextcloudDavClient(dav, { serverUrl, loginName: "alice", appPassword: "fixture" }, logger), root, logger);
    const service = new RemoteInventoryService(scanner, new RemoteInventoryReconciler(store), store, logger, undefined,
      async () => { started(); await gate; });
    const pending = service.scanFull("Obsidian"); await waiting;
    const generation = store.summary().generation;
    service.close(); release();
    await expect(pending).rejects.toThrow(/closed before reconciliation/);
    expect(store.summary().generation).toBe(generation);
    expect(Object.values(store.getState().files)).toHaveLength(0);
    expect(service.summary().status).toBe("closed");
    expect(service.summary().lastScanComplete).toBe(false);
    await store.close();
  });
});
