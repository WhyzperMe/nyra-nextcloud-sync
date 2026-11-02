import { expect, it } from "vitest";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { SyncPlanner } from "../src/planner/planner";
import { NextcloudDavClient } from "../src/remote/dav-client";
import { RemoteInventoryScanner } from "../src/remote/scanner";
import { RemoteInventoryReconciler } from "../src/remote/reconciler";
import { DurableStateStore } from "../src/state/durable/store";
import type { FileReplicaInput } from "../src/state/durable/model";
import { TransferJournalStore } from "../src/transfer/journal";
import { MemoryStateBackend } from "./helpers/memory-backend";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { FaultInjectingTransport } from "./helpers/fault-injecting-transport";
import { sha256Hex } from "../src/state/durable/crypto";

it("reconciles a partially completed parallel upload after restart without losing either version", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const scope = "9".repeat(32), server = "https://cloud.example", root = `${server}/remote.php/dav/files/u/`;
  const credentials = { serverUrl: server, loginName: "u", appPassword: "test" };
  const tuning = { chunkUploadThresholdBytes: 1024, uploadChunkBytes: 1024, downloadRangeChunkBytes: 1024, maxWholeDownloadBytes: 1024 };
  const backend = new MemoryStateBackend(), adapter = new MemoryVaultAdapter(), vault = makeMemoryVault(adapter);
  let store = await DurableStateStore.open(backend, logger);
  let local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, scope);
  await local.initializeAndRecover();
  const entries: FileReplicaInput[] = [];
  for (const name of ["A", "B"]) {
    await adapter.write(`${name}.md`, `content-${name}`);
    const verified = await local.readVerified(`${name}.md`);
    entries.push({ entryId: `file_restart${name}`, path: verified.path, baseline: null,
      local: { path: verified.path, contentHash: verified.contentHash, size: verified.size, mtimeMs: verified.mtimeMs }, remote: null, status: "local-dirty" as const });
  }
  await store.transact("restart-seed", (tx) => { for (const entry of entries) tx.putFile(entry); });
  const dav = new FakeNextcloudDav(server, "u");
  const fault = new FaultInjectingTransport(dav, [{ id: "offline-B", method: "PUT", urlIncludes: "B.md", phase: "before", action: { kind: "throw", message: "injected offline" } }]);
  let journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, scope);
  let remote = new RemoteTransactionalMutator(fault, credentials, logger, { serverUrl: server, userId: "u", webdavUserRoot: root, tuning, journal, maxAttempts: 1 });
  const policy = { allowDestructive: false, allowMerge: false, maxOperations: 20, transferConcurrency: 2, transferMemoryBytes: 4096 };
  let executor = new TransactionalSyncExecutor(store, local, remote, root, "Obsidian", tuning, logger);
  await expect(executor.execute(await new SyncPlanner().build(store.getState()), policy)).rejects.toThrow(/injected offline/);
  expect(fault.hitCount("offline-B")).toBe(1);
  expect(new TextDecoder().decode(dav.getFile(`${root}Obsidian/A.md`)!)).toBe("content-A");
  expect(dav.getFile(`${root}Obsidian/B.md`)).toBeNull();
  // A finished and was verified before B failed, so it is recorded; B is not.
  expect(store.getState().files.file_restartA?.baseline).not.toBeNull();
  expect(store.getState().files.file_restartB?.baseline).toBeNull();
  await store.close();

  store = await DurableStateStore.open(backend, logger);
  local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, scope);
  await local.initializeAndRecover();
  journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, scope);
  remote = new RemoteTransactionalMutator(dav, credentials, logger, { serverUrl: server, userId: "u", webdavUserRoot: root, tuning, journal, maxAttempts: 1 });
  await remote.recoverIncompleteTransfers();
  const scanner = new RemoteInventoryScanner(new NextcloudDavClient(dav, credentials, logger), root, logger);
  const scan = await scanner.scanFull("Obsidian");
  expect(scan.complete).toBe(true);
  await new RemoteInventoryReconciler(store).applyFullScan(scan);
  executor = new TransactionalSyncExecutor(store, local, remote, root, "Obsidian", tuning, logger);
  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await new SyncPlanner().build(store.getState());
    if (plan.summary.ready + plan.summary.needsVerification === 0) break;
    await executor.execute(plan, policy);
  }
  expect(await adapter.read("A.md")).toBe("content-A");
  expect(await adapter.read("B.md")).toBe("content-B");
  expect(new TextDecoder().decode(dav.getFile(`${root}Obsidian/A.md`)!)).toBe("content-A");
  expect(new TextDecoder().decode(dav.getFile(`${root}Obsidian/B.md`)!)).toBe("content-B");
  expect(store.getState().files.file_restartA?.status).toBe("clean");
  expect(store.getState().files.file_restartB?.status).toBe("clean");
});

it("resumes an interrupted chunked upload while a parallel upload completes", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const scope = "8".repeat(32), server = "https://cloud.example", root = `${server}/remote.php/dav/files/u/`;
  const credentials = { serverUrl: server, loginName: "u", appPassword: "test" }, mib = 1024 * 1024;
  const tuning = { chunkUploadThresholdBytes: 5 * mib, uploadChunkBytes: 5 * mib, downloadRangeChunkBytes: 2 * mib, maxWholeDownloadBytes: 5 * mib };
  const backend = new MemoryStateBackend(), adapter = new MemoryVaultAdapter(), vault = makeMemoryVault(adapter);
  let store = await DurableStateStore.open(backend, logger);
  let local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, scope);
  await local.initializeAndRecover();
  const records: FileReplicaInput[] = [];
  for (const name of ["A", "B"]) {
    await adapter.writeBinary(`${name}.bin`, new Uint8Array(5 * mib + 1024).fill(name.charCodeAt(0)).buffer);
    const verified = await local.readVerified(`${name}.bin`);
    records.push({ entryId: `file_chunks${name}`, path: verified.path, baseline: null,
      local: { path: verified.path, contentHash: verified.contentHash, size: verified.size, mtimeMs: verified.mtimeMs }, remote: null, status: "local-dirty" });
  }
  await store.transact("chunk-seed", (tx) => { for (const record of records) tx.putFile(record); });
  const dav = new FakeNextcloudDav(server, "u");
  let journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, scope);
  let failed = false;
  let firstChunks = 0, releaseChunks!: () => void;
  const bothChunksStarted = new Promise<void>((resolve) => { releaseChunks = resolve; });
  const transport = { async request(request: Parameters<typeof dav.request>[0]) {
    if (request.method === "PUT" && request.url.endsWith("/00001")) {
      if (++firstChunks === 2) releaseChunks();
      await bothChunksStarted;
    }
    if (!failed && request.method === "PUT" && request.url.endsWith("/00002")) {
      const records = await journal.listLatest();
      if (records.some((record) => record.targetPath === "B.bin" && request.url.startsWith(`${record.uploadUrl}/`))) {
        failed = true;
        throw new Error("injected chunk interruption");
      }
    }
    return await dav.request(request);
  } };
  let remote = new RemoteTransactionalMutator(transport, credentials, logger, { serverUrl: server, userId: "u", webdavUserRoot: root, tuning, journal, maxAttempts: 1 });
  const policy = { allowDestructive: false, allowMerge: false, maxOperations: 20, transferConcurrency: 2, transferMemoryBytes: 64 * mib };
  let executor = new TransactionalSyncExecutor(store, local, remote, root, "Obsidian", tuning, logger);
  await expect(executor.execute(await new SyncPlanner().build(store.getState()), policy)).rejects.toThrow(/injected chunk interruption/);
  expect(firstChunks).toBe(2);
  expect(failed).toBe(true);
  expect(dav.getFile(`${root}Obsidian/A.bin`)).not.toBeNull();
  expect(dav.getFile(`${root}Obsidian/B.bin`)).toBeNull();
  expect((await journal.listLatest()).some((record) => record.targetPath === "B.bin" && record.uploadedChunks.includes(0))).toBe(true);
  await store.close();
  store = await DurableStateStore.open(backend, logger);
  local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, scope);
  await local.initializeAndRecover();
  journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, scope);
  remote = new RemoteTransactionalMutator(dav, credentials, logger, { serverUrl: server, userId: "u", webdavUserRoot: root, tuning, journal, maxAttempts: 1 });
  await remote.recoverIncompleteTransfers();
  const scan = await new RemoteInventoryScanner(new NextcloudDavClient(dav, credentials, logger), root, logger).scanFull("Obsidian");
  expect(scan.complete).toBe(true);
  await new RemoteInventoryReconciler(store).applyFullScan(scan);
  executor = new TransactionalSyncExecutor(store, local, remote, root, "Obsidian", tuning, logger);
  let resumed = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await new SyncPlanner().build(store.getState());
    if (!plan.summary.ready && !plan.summary.needsVerification) break;
    resumed += (await executor.execute(plan, policy)).resumedTransfers;
  }
  expect(resumed).toBe(1);
  for (const record of records) {
    const remoteBytes = dav.getFile(`${root}Obsidian/${record.path}`);
    expect(remoteBytes).not.toBeNull();
    expect(await sha256Hex(remoteBytes!)).toBe(record.local!.contentHash);
    expect(await sha256Hex(await adapter.readBinary(record.path))).toBe(record.local!.contentHash);
    expect(store.getState().files[record.entryId]?.status).toBe("clean");
  }
  expect(await journal.listLatest()).toEqual([]);
}, 60_000);
