import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalTransactionalMutator } from "../src/execution/local-mutator";
import { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { sha256Hex } from "../src/state/durable/crypto";
import { TransferJournalStore } from "../src/transfer/journal";
import type { TransferTuning } from "../src/transfer/types";
import { FaultInjectingDataAdapter } from "./helpers/fault-injecting-adapter";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { FaultInjectingTransport } from "./helpers/fault-injecting-transport";
import { MemoryVaultAdapter, makeMemoryVault } from "./helpers/memory-vault";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEVICE_SCOPE = "a".repeat(32);
const MIB = 1024 * 1024;
const server = "https://cloud.adversarial.test";
const userId = "chaos";
const root = `${server}/remote.php/dav/files/${userId}/Obsidian/`;
const credentials = { serverUrl: server, loginName: userId, appPassword: "adversarial-test" };
const tuning: TransferTuning = {
  chunkUploadThresholdBytes: 5 * MIB,
  uploadChunkBytes: 5 * MIB,
  downloadRangeChunkBytes: 1 * MIB,
  maxWholeDownloadBytes: 1 * MIB
};

async function makeMutator(http: FakeNextcloudDav | FaultInjectingTransport, sleeps: number[] = []): Promise<RemoteTransactionalMutator> {
  const journal = new TransferJournalStore(makeMemoryVault(), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
  await journal.ensure();
  return new RemoteTransactionalMutator(http, credentials, logger, {
    serverUrl: server,
    userId,
    webdavUserRoot: `${server}/remote.php/dav/files/${userId}/`,
    tuning,
    journal,
    maxAttempts: 3,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5
  });
}

describe("Adversarial ambiguous-completion reconciliation", () => {
  it("accepts a direct create whose response is lost after the server commits", async () => {
    const dav = new FakeNextcloudDav(server, userId);
    const target = `${root}Create.md`;
    const fault = new FaultInjectingTransport(dav, [{ id: "lost-create-response", method: "PUT", urlIncludes: "Create.md", phase: "after", action: { kind: "throw", message: "connection reset after commit" } }]);
    const mutator = await makeMutator(fault);
    const bytes = new TextEncoder().encode("created safely").buffer;
    const result = await mutator.uploadCreate(target, "Create.md", bytes);
    expect(result.contentHash).toBe(await sha256Hex(bytes));
    expect(fault.hitCount("lost-create-response")).toBe(1);
  });

  it("accepts a direct update whose response is lost after commit", async () => {
    const dav = new FakeNextcloudDav(server, userId);
    const baseMutator = await makeMutator(dav);
    const target = `${root}Update.md`;
    const initial = await baseMutator.uploadCreate(target, "Update.md", new TextEncoder().encode("old").buffer);
    const fault = new FaultInjectingTransport(dav, [{ id: "lost-update-response", method: "PUT", urlIncludes: "Update.md", phase: "after", action: { kind: "throw", message: "socket closed after update" } }]);
    const mutator = await makeMutator(fault);
    const bytes = new TextEncoder().encode("new").buffer;
    const result = await mutator.uploadUpdate(target, "Update.md", bytes, initial.remote.fileId, initial.remote.etag);
    expect(result.contentHash).toBe(await sha256Hex(bytes));
    expect(result.remote.fileId).toBe(initial.remote.fileId);
  });

  it("reconciles MOVE and DELETE responses lost after commit", async () => {
    const dav = new FakeNextcloudDav(server, userId);
    const baseMutator = await makeMutator(dav);
    const sourceUrl = `${root}MoveA.md`;
    const targetUrl = `${root}MoveB.md`;
    const initial = await baseMutator.uploadCreate(sourceUrl, "MoveA.md", new TextEncoder().encode("move me").buffer);

    const moveFault = new FaultInjectingTransport(dav, [{ id: "lost-move-response", method: "MOVE", urlIncludes: "MoveA.md", phase: "after", action: { kind: "throw", message: "lost MOVE response" } }]);
    const moveMutator = await makeMutator(moveFault);
    const moved = await moveMutator.move(sourceUrl, "MoveA.md", targetUrl, "MoveB.md", initial.remote.fileId, initial.remote.etag);
    expect(moved.fileId).toBe(initial.remote.fileId);

    const deleteFault = new FaultInjectingTransport(dav, [{ id: "lost-delete-response", method: "DELETE", urlIncludes: "MoveB.md", phase: "after", action: { kind: "throw", message: "lost DELETE response" } }]);
    const deleteMutator = await makeMutator(deleteFault);
    await deleteMutator.remove(targetUrl, "MoveB.md", moved.fileId, moved.etag);
    expect(dav.getFile(targetUrl)).toBe(null);
  });
});

describe("Adversarial retry and corruption fences", () => {
  it("honors a retryable 423 without sleeping during deterministic tests", async () => {
    const dav = new FakeNextcloudDav(server, userId);
    const base = await makeMutator(dav);
    const target = `${root}Locked.md`;
    await base.uploadCreate(target, "Locked.md", new TextEncoder().encode("locked").buffer);
    const sleeps: number[] = [];
    const fault = new FaultInjectingTransport(dav, [{ id: "locked-once", method: "PROPFIND", urlIncludes: "Locked.md", phase: "before", action: { kind: "status", status: 423, headers: { "Retry-After": "0" } } }]);
    const mutator = await makeMutator(fault, sleeps);
    const stat = await mutator.stat(target, "Locked.md");
    expect(stat.size).toBe(6);
    expect(fault.hitCount("locked-once")).toBe(1);
    expect(sleeps.length).toBe(1);
    expect((sleeps[0] ?? 0) >= 250).toBe(true);
  });

  it("fails closed when a ranged response is truncated", async () => {
    const dav = new FakeNextcloudDav(server, userId);
    const bytes = patterned(2 * MIB + 17);
    await dav.request({ url: `${root}Range.bin`, method: "PUT", body: bytes.buffer });
    const fault = new FaultInjectingTransport(dav, [{ id: "truncate-range", method: "GET", urlIncludes: "Range.bin", phase: "after", action: { kind: "truncate-body", bytes: 1 } }]);
    const mutator = await makeMutator(fault);
    await expect(mutator.verifyRemoteContent(`${root}Range.bin`, "Range.bin", null, null)).rejects.toThrow(/Ranged download returned/);
  });
});

describe("Adversarial local ambiguous completion", () => {
  it("restores a concurrent edit before installing a planned replacement", async () => {
    class UserEditBeforeReplaceRenameAdapter extends MemoryVaultAdapter {
      private edited = false;
      override async rename(from: string, to: string): Promise<void> {
        if (!this.edited && from === "ReplaceRace.md" && to.includes("/apply/recovery/")) {
          this.edited = true;
          await this.writeBinary(from, new TextEncoder().encode("concurrent user version").buffer);
        }
        await super.rename(from, to);
      }
    }
    const adapter = new UserEditBeforeReplaceRenameAdapter();
    const original = new TextEncoder().encode("planned source").buffer;
    const changed = new TextEncoder().encode("concurrent user version").buffer;
    const replacement = new TextEncoder().encode("remote replacement").buffer;
    await adapter.writeBinary("ReplaceRace.md", original);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();

    await expect(mutator.writeAtomic("ReplaceRace.md", replacement, await sha256Hex(original)))
      .rejects.toThrow(/changed before replacement/);
    expect(await sha256Hex(await adapter.readBinary("ReplaceRace.md"))).toBe(await sha256Hex(changed));
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    expect((await adapter.list(`${runtime}/journal`)).files).toHaveLength(0);
    expect((await adapter.list(`${runtime}/recovery`)).files).toHaveLength(0);
  });

  it("restores a concurrent local edit instead of deleting a changed version", async () => {
    class UserEditBeforeDeleteRenameAdapter extends MemoryVaultAdapter {
      private edited = false;
      override async rename(from: string, to: string): Promise<void> {
        if (!this.edited && from === "DeleteRace.md" && to.includes("/apply/recovery/")) {
          this.edited = true;
          await this.writeBinary(from, new TextEncoder().encode("new user edit").buffer);
        }
        await super.rename(from, to);
      }
    }
    const adapter = new UserEditBeforeDeleteRenameAdapter();
    const oldBytes = new TextEncoder().encode("planned old bytes").buffer;
    const newBytes = new TextEncoder().encode("new user edit").buffer;
    await adapter.writeBinary("DeleteRace.md", oldBytes);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();

    await expect(mutator.deleteVerified("DeleteRace.md", await sha256Hex(oldBytes)))
      .rejects.toThrow(/changed during the operation/);
    expect(await sha256Hex(await adapter.readBinary("DeleteRace.md"))).toBe(await sha256Hex(newBytes));
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    expect((await adapter.list(`${runtime}/journal`)).files).toHaveLength(0);
    expect((await adapter.list(`${runtime}/recovery`)).files).toHaveLength(0);
  });

  it("restores a delete backup after restart before durable sync state can advance", async () => {
    const adapter = new MemoryVaultAdapter();
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    const operationId = `apply_${"f".repeat(32)}`;
    const bytes = new TextEncoder().encode("recover interrupted deletion").buffer;
    const hash = await sha256Hex(bytes);
    const manifestPath = `${runtime}/journal/${operationId}.json`;
    const recoveryPath = `${runtime}/recovery/${operationId}.bak`;
    await adapter.writeBinary(recoveryPath, bytes);
    await adapter.write(manifestPath, JSON.stringify({
      version: 3,
      operationId,
      kind: "delete",
      sourcePath: null,
      targetPath: "InterruptedDelete.md",
      stagingPath: null,
      recoveryPath,
      expectedSourceHash: hash,
      desiredHash: hash,
      desiredSize: bytes.byteLength,
      createdAt: new Date().toISOString()
    }));

    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();

    expect(await sha256Hex(await adapter.readBinary("InterruptedDelete.md"))).toBe(hash);
    expect(await adapter.exists(recoveryPath)).toBe(false);
    expect(await adapter.exists(manifestPath)).toBe(false);
  });

  it("uses a verified recovery intent for a completed local delete", async () => {
    const adapter = new MemoryVaultAdapter();
    const bytes = new TextEncoder().encode("delete only the verified version").buffer;
    await adapter.writeBinary("VerifiedDelete.md", bytes);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();

    await mutator.deleteVerified("VerifiedDelete.md", await sha256Hex(bytes));

    expect(await adapter.exists("VerifiedDelete.md")).toBe(false);
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    expect((await adapter.list(`${runtime}/journal`)).files).toHaveLength(0);
    expect((await adapter.list(`${runtime}/recovery`)).files).toHaveLength(0);
  });

  it("reconciles a local delete when the adapter loses the rename response", async () => {
    const base = new MemoryVaultAdapter();
    const bytes = new TextEncoder().encode("committed delete").buffer;
    await base.writeBinary("LostDeleteResponse.md", bytes);
    const faulting = new FaultInjectingDataAdapter(base, [{
      id: "delete-rename-after-commit",
      operation: "rename",
      phase: "after",
      pathIncludes: "LostDeleteResponse.md ->",
    }]);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(faulting), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();

    await mutator.deleteVerified("LostDeleteResponse.md", await sha256Hex(bytes));

    expect(faulting.hitCount("delete-rename-after-commit")).toBe(1);
    expect(await base.exists("LostDeleteResponse.md")).toBe(false);
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    expect((await base.list(`${runtime}/journal`)).files).toHaveLength(0);
    expect((await base.list(`${runtime}/recovery`)).files).toHaveLength(0);
  });

  it("rejects a forged delete recovery path without touching unrelated data", async () => {
    const adapter = new MemoryVaultAdapter();
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    const operationId = `apply_${"c".repeat(32)}`;
    const targetBytes = new TextEncoder().encode("delete target remains").buffer;
    const privateBytes = new TextEncoder().encode("unrelated data remains").buffer;
    const targetHash = await sha256Hex(targetBytes);
    await adapter.writeBinary("DeleteTarget.md", targetBytes);
    await adapter.writeBinary("Private.md", privateBytes);
    const manifestPath = `${runtime}/journal/${operationId}.json`;
    await adapter.write(manifestPath, JSON.stringify({
      version: 3,
      operationId,
      kind: "delete",
      sourcePath: null,
      targetPath: "DeleteTarget.md",
      stagingPath: null,
      recoveryPath: "Private.md",
      expectedSourceHash: targetHash,
      desiredHash: targetHash,
      desiredSize: targetBytes.byteLength,
      createdAt: new Date().toISOString()
    }));

    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await expect(mutator.initializeAndRecover()).rejects.toThrow(/Local apply recovery failed/);
    expect(await sha256Hex(await adapter.readBinary("DeleteTarget.md"))).toBe(targetHash);
    expect(await sha256Hex(await adapter.readBinary("Private.md"))).toBe(await sha256Hex(privateBytes));
    expect(await adapter.exists(manifestPath)).toBe(true);
  });

  it("fails closed on a forged recovery path without moving or deleting user files", async () => {
    const adapter = new MemoryVaultAdapter();
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    const operationId = `apply_${"d".repeat(32)}`;
    const originalTarget = new TextEncoder().encode("target remains").buffer;
    const unrelatedUserFile = new TextEncoder().encode("do not move or delete").buffer;
    await adapter.writeBinary("Target.md", originalTarget);
    await adapter.writeBinary("Private.md", unrelatedUserFile);
    const manifestPath = `${runtime}/journal/${operationId}.json`;
    await adapter.write(manifestPath, JSON.stringify({
      version: 2,
      operationId,
      kind: "replace",
      sourcePath: null,
      targetPath: "Target.md",
      stagingPath: `${runtime}/staging/${operationId}.bin`,
      recoveryPath: "Private.md",
      expectedSourceHash: await sha256Hex(originalTarget),
      desiredHash: await sha256Hex(new TextEncoder().encode("replacement").buffer),
      desiredSize: "10",
      createdAt: new Date().toISOString()
    }));

    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await expect(mutator.initializeAndRecover()).rejects.toThrow(/Local apply recovery failed/);
    expect(await sha256Hex(await adapter.readBinary("Target.md"))).toBe(await sha256Hex(originalTarget));
    expect(await sha256Hex(await adapter.readBinary("Private.md"))).toBe(await sha256Hex(unrelatedUserFile));
    expect(await adapter.exists(manifestPath)).toBe(true);
  });

  it("rejects a forged traversal target before recovery can touch any path", async () => {
    const adapter = new MemoryVaultAdapter();
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply`;
    const operationId = `apply_${"e".repeat(32)}`;
    const important = new TextEncoder().encode("must remain").buffer;
    await adapter.writeBinary("Important.md", important);
    const manifestPath = `${runtime}/journal/${operationId}.json`;
    await adapter.write(manifestPath, JSON.stringify({
      version: 2,
      operationId,
      kind: "replace",
      sourcePath: null,
      targetPath: "../../Important.md",
      stagingPath: `${runtime}/staging/${operationId}.bin`,
      recoveryPath: null,
      expectedSourceHash: null,
      desiredHash: await sha256Hex(new ArrayBuffer(0)),
      desiredSize: 0,
      createdAt: new Date().toISOString()
    }));

    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await expect(mutator.initializeAndRecover()).rejects.toThrow(/Local apply recovery failed/);
    expect(await sha256Hex(await adapter.readBinary("Important.md"))).toBe(await sha256Hex(important));
    expect(await adapter.exists(manifestPath)).toBe(true);
  });

  it("cleans only recognized abandoned staging and snapshot entries while preserving unknown evidence", async () => {
    const adapter = new MemoryVaultAdapter();
    const runtime = `.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}`;
    const orphanStaging = `${runtime}/apply/staging/apply_${"a".repeat(32)}.bin`;
    const unknownStaging = `${runtime}/apply/staging/keep.marker`;
    const nestedStaging = `${runtime}/apply/staging/unknown-folder/evidence.bin`;
    const cleanSnapshot = `${runtime}/transfer/local-snapshots/snapshot_${"b".repeat(32)}`;
    const unknownSnapshot = `${runtime}/transfer/local-snapshots/snapshot_${"c".repeat(32)}`;
    const unknownSnapshotFile = `${runtime}/transfer/local-snapshots/private-evidence.bin`;
    await adapter.writeBinary(orphanStaging, new ArrayBuffer(1));
    await adapter.writeBinary(unknownStaging, new ArrayBuffer(1));
    await adapter.writeBinary(nestedStaging, new ArrayBuffer(1));
    await adapter.writeBinary(`${cleanSnapshot}/00000.bin`, new ArrayBuffer(1));
    await adapter.writeBinary(`${unknownSnapshot}/00000.bin`, new ArrayBuffer(1));
    await adapter.writeBinary(`${unknownSnapshot}/keep.marker`, new ArrayBuffer(1));
    await adapter.writeBinary(unknownSnapshotFile, new ArrayBuffer(1));

    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();

    expect(await adapter.exists(orphanStaging)).toBe(false);
    expect(await adapter.exists(`${cleanSnapshot}/00000.bin`)).toBe(false);
    expect(await adapter.exists(unknownStaging)).toBe(true);
    expect(await adapter.exists(nestedStaging)).toBe(true);
    expect(await adapter.exists(`${unknownSnapshot}/00000.bin`)).toBe(true);
    expect(await adapter.exists(`${unknownSnapshot}/keep.marker`)).toBe(true);
    expect(await adapter.exists(unknownSnapshotFile)).toBe(true);
  });

  it("proves and accepts a local move that committed before the adapter threw", async () => {
    const base = new MemoryVaultAdapter();
    const sourceBytes = new TextEncoder().encode("local move").buffer;
    await base.writeBinary("Crash.txt", sourceBytes);
    const hash = await sha256Hex(sourceBytes);
    const faulting = new FaultInjectingDataAdapter(base, [{ id: "move-after-commit", operation: "rename", phase: "after", pathIncludes: "Crash.txt -> Recovered.txt" }]);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(faulting), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();
    const result = await mutator.moveAtomic("Crash.txt", "Recovered.txt", hash);
    expect(result.contentHash).toBe(hash);
    expect(await base.exists("Crash.txt")).toBe(false);
    expect(await base.exists("Recovered.txt")).toBe(true);
    expect(faulting.hitCount("move-after-commit")).toBe(1);
  });

  it("proves and accepts a local replace that committed before the adapter threw", async () => {
    const base = new MemoryVaultAdapter();
    const oldBytes = new TextEncoder().encode("old").buffer;
    const newBytes = new TextEncoder().encode("new-content").buffer;
    await base.writeBinary("Replace.txt", oldBytes);
    const oldHash = await sha256Hex(oldBytes);
    const newHash = await sha256Hex(newBytes);
    const faulting = new FaultInjectingDataAdapter(base, [{ id: "replace-install-after-commit", operation: "rename", phase: "after", pathIncludes: `runtime/${DEVICE_SCOPE}/apply/staging/`, occurrence: 1 }]);
    const mutator = new LocalTransactionalMutator(makeMemoryVault(faulting), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();
    const result = await mutator.writeAtomic("Replace.txt", newBytes, oldHash);
    expect(result.contentHash).toBe(newHash);
    expect(await sha256Hex(await base.readBinary("Replace.txt"))).toBe(newHash);
  });

  it("recovers safely when durable replace intent is written before the old target moves", async () => {
    const base = new MemoryVaultAdapter();
    const oldBytes = new TextEncoder().encode("keep-old").buffer;
    const newBytes = new TextEncoder().encode("install-new").buffer;
    await base.writeBinary("CrashReplace.txt", oldBytes);
    const oldHash = await sha256Hex(oldBytes);
    const newHash = await sha256Hex(newBytes);
    const faulting = new FaultInjectingDataAdapter(base, [{
      id: "manifest-after-commit", operation: "rename", phase: "after", pathIncludes: `runtime/${DEVICE_SCOPE}/apply/journal/`
    }]);
    const interrupted = new LocalTransactionalMutator(makeMemoryVault(faulting), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await interrupted.initializeAndRecover();

    await expect(interrupted.writeAtomic("CrashReplace.txt", newBytes, oldHash)).rejects.toThrow(/manifest-after-commit/);
    expect(await sha256Hex(await base.readBinary("CrashReplace.txt"))).toBe(oldHash);

    const recovered = new LocalTransactionalMutator(makeMemoryVault(base), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await recovered.initializeAndRecover();
    expect(await sha256Hex(await base.readBinary("CrashReplace.txt"))).toBe(oldHash);
    const staging = await base.list(`.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply/staging`);
    const journal = await base.list(`.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply/journal`);
    expect(staging.files.length).toBe(0);
    expect(journal.files.length).toBe(0);
    expect(newHash === oldHash).toBe(false);
  });

  it("removes incomplete temporary staging after a streamed source fails", async () => {
    const adapter = new MemoryVaultAdapter();
    const mutator = new LocalTransactionalMutator(makeMemoryVault(adapter), "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await mutator.initializeAndRecover();
    const bytes = new TextEncoder().encode("partial").buffer;
    async function* failingStream(): AsyncIterable<ArrayBuffer> {
      yield bytes;
      throw new Error("source stream interrupted");
    }

    await expect(mutator.writeAtomicFromChunks("Partial.txt", failingStream(), null, null, bytes.byteLength))
      .rejects.toThrow(/source stream interrupted/);
    expect(await adapter.exists("Partial.txt")).toBe(false);
    const staging = await adapter.list(`.obsidian/plugins/nyra-nextcloud-sync/runtime/${DEVICE_SCOPE}/apply/staging`);
    expect(staging.files.length).toBe(0);
  });
});

function patterned(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 17 + 23) & 0xff;
  return out;
}
