import type { Logger } from "../src/diagnostics/logger";
import type { HttpTransport } from "../src/network/http-client";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import { LocalPathPolicy } from "../src/local/path-policy";
import { ObsidianVaultFileSource } from "../src/local/obsidian-source";
import { LocalInventoryScanner } from "../src/local/scanner";
import { LocalInventoryReconciler } from "../src/local/reconciler";
import { NextcloudDavClient } from "../src/remote/dav-client";
import { RemoteInventoryScanner } from "../src/remote/scanner";
import { RemoteInventoryReconciler } from "../src/remote/reconciler";
import { SyncPlanner } from "../src/planner/planner";
import type { SyncPlan } from "../src/planner/types";
import { SyncCycleRunner } from "../src/sync/cycle-runner";
import { DurableStateStore } from "../src/state/durable/store";
import { sha256Hex } from "../src/state/durable/crypto";
import { TransferJournalStore } from "../src/transfer/journal";
import type { TransferTuning } from "../src/transfer/types";
import { nextcloudEndpoints } from "../src/nextcloud/endpoints";
import { appendWebdavPath } from "../src/remote/path";
import { MemoryVaultAdapter, makeMemoryVault } from "../tests/helpers/memory-vault";
import { MemoryStateBackend } from "../tests/helpers/memory-backend";
import type { AcceptanceConfig } from "./acceptance-safety";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const tuning: TransferTuning = { chunkUploadThresholdBytes: 5 * 1024 * 1024, uploadChunkBytes: 5 * 1024 * 1024, downloadRangeChunkBytes: 1024 * 1024, maxWholeDownloadBytes: 5 * 1024 * 1024 };

/** The caller owns the unique test tree and its cleanup; no production vault is opened. */
export async function runEngineScenarios(config: AcceptanceConfig, rootPath: string, http: HttpTransport): Promise<string[]> {
  const userRoot = nextcloudEndpoints.webdavUserRoot(config.serverUrl, config.userId);
  const credentials = { serverUrl: config.serverUrl, loginName: config.userId, appPassword: config.appPassword };
  const policy = new LocalPathPolicy([".obsidian", ".trash"]);
  const path = "New folder/Nested/note.md";

  async function device(adapter = new MemoryVaultAdapter(Date.now()), backend = new MemoryStateBackend()) {
    const vault = makeMemoryVault(adapter);
    const store = await DurableStateStore.open(backend, logger);
    const local = new LocalTransactionalMutator(vault, "nyra-nextcloud-sync", logger, "d".repeat(32));
    await local.initializeAndRecover();
    const journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, "d".repeat(32));
    await journal.ensure();
    const remote = new RemoteTransactionalMutator(http, credentials, logger, { serverUrl: config.serverUrl, userId: config.userId, webdavUserRoot: userRoot, tuning, journal });
    const capabilityProbe = new RemoteTransactionalMutator(http, credentials, logger, {
      serverUrl: config.serverUrl, userId: config.userId,
      webdavUserRoot: appendWebdavPath(userRoot, rootPath), tuning, journal
    });
    const localScanner = new LocalInventoryScanner(new ObsidianVaultFileSource(vault, policy), policy);
    const remoteScanner = new RemoteInventoryScanner(new NextcloudDavClient(http, credentials, logger), userRoot, logger, { pathPolicy: policy });
    const executor = new TransactionalSyncExecutor(store, local, remote, userRoot, rootPath, tuning, logger);
    let localComplete = false;
    let remoteComplete = false;
    let plan: SyncPlan | null = null;
    const runner = new SyncCycleRunner({
      localFactsComplete: () => localComplete, remoteFactsComplete: () => remoteComplete,
      lastFullLocalScanAt: () => 0, now: Date.now, flushLocalHints: async () => {}, waitForLocalInventory: async () => {},
      scanLocalFull: async () => {
        const scan = await localScanner.scanFull();
        await new LocalInventoryReconciler(store, policy).applyFullScan(scan, { exactRenames: [], allowNewRecords: true });
        return localComplete = scan.complete;
      },
      scanRemoteFull: async () => {
        const scan = await remoteScanner.scanFull(rootPath);
        await new RemoteInventoryReconciler(store, policy).applyFullScan(scan);
        return remoteComplete = scan.trust === "authoritative";
      },
      buildPlan: async () => plan = await new SyncPlanner().build(store.getState()), autoMergeEnabled: () => true,
      applyPlan: async (allowDeletes) => {
        if (!plan) throw new Error("Engine test plan missing");
        return await executor.execute(plan, { allowDestructive: allowDeletes, allowMerge: true, maxOperations: 100 });
      },
      syncFolders: async () => 0
    });
    return {
      adapter, backend, store, remote,
      verifyCapabilities: async () => await capabilityProbe.verifyConditionalWrites("capability-scope"),
      sync: async (allowDeletes = false) => { for (let i = 0; i < 3; i++) await runner.run("manual", allowDeletes); },
      read: async () => await adapter.read(path),
      close: async () => { executor.close(); await store.close(); }
    };
  }

  const a = await device();
  let b = await device();
  let phase = "isolated production conditional-write probe";
  try {
    await a.remote.ensureDirectoryPath(userRoot, rootPath);
    await a.verifyCapabilities();
    phase = "nested create on device A";
    await a.adapter.write(path, "one\ntwo\nthree\nfour\n");
    await a.sync();
    phase = "initial download on device B";
    await b.sync();
    check(await b.read() === await a.read(), "New nested file did not converge");
    await a.adapter.write(path, "LOCAL\ntwo\nthree\nfour\n");
    await b.adapter.write(path, "one\ntwo\nthree\nREMOTE\n");
    phase = "local edit upload on device A";
    await a.sync();
    phase = "independent edit merge on device B";
    await b.sync();
    phase = "merged content download on device A";
    await a.sync();
    check(await a.read() === "LOCAL\ntwo\nthree\nREMOTE\n", "Independent edits did not merge");
    check(await b.read() === await a.read(), "Merged peers differ");
    const hash = await sha256Hex(new TextEncoder().encode(await a.read()));
    check(Object.values(a.store.getState().files)[0]?.baseline?.blobHash === hash, "Merged BASE was not verified");

    await b.close();
    phase = "durable reopen on device B";
    b = await device(b.adapter, b.backend);
    await b.sync();
    check(await b.read() === await a.read(), "Restart changed converged content");

    await a.adapter.remove("New folder");
    await b.adapter.write(path, "Peer edit while the first device was offline\n");
    phase = "offline peer edit";
    await b.sync();
    phase = "delete versus changed peer";
    await a.sync(true);
    check(!await a.adapter.exists("New folder"), "Delete-versus-edit recreated a local folder");
    check(await b.read() === "Peer edit while the first device was offline\n", "Delete-versus-edit lost the peer's version");
    check((await new SyncPlanner().build(a.store.getState())).summary.blocked > 0, "Delete-versus-edit was not blocked");
    await a.adapter.write(path, await b.read());
    phase = "explicit conflict convergence";
    await a.sync();
    await a.adapter.remove("New folder");
    phase = "deletion with policy disabled";
    await a.sync(false);
    check(!await a.adapter.exists("New folder"), "Blocked deletion resurrected its local folder");
    check(await b.adapter.exists(path), "Deletion propagated despite disabled policy");
    phase = "deletion with policy enabled";
    await a.sync(true);
    await b.sync(true);
    phase = "repeated no-resurrection scans";
    for (let round = 0; round < 3; round++) {
      await a.sync(true);
      await b.sync(true);
      check(!await a.adapter.exists("New folder"), "Repeated discovery resurrected a deleted folder");
      check(!await b.adapter.exists(path), "Peer resurrected a deleted file");
    }
    return ["production cycle: nested create and second-device download", "production cycle: two-device automatic merge and verified BASE", "production cycle: durable reopen/reconnect", "production cycle: offline folder deletion versus peer edit stays blocked", "production cycle: delete policy, tombstones, and repeated no-resurrection scans"];
  } catch (error) {
    throw new Error(`Engine scenario '${phase}' failed: ${error instanceof Error ? error.message : "Unknown failure"}`);
  } finally {
    await a.close();
    await b.close();
  }
}

function check(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
