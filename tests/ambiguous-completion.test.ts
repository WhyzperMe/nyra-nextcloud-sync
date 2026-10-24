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
const DEVICE_SCOPE = "e".repeat(32);
const MIB = 1024 * 1024;
const server = "https://cloud.stage8.test";
const userId = "chaos";
const root = `${server}/remote.php/dav/files/${userId}/Obsidian/`;
const credentials = { serverUrl: server, loginName: userId, appPassword: "stage8-test" };
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

describe("Ambiguous-completion reconciliation", () => {
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

describe("Retry and corruption fences", () => {
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

describe("Local ambiguous completion", () => {
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
});

function patterned(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 17 + 23) & 0xff;
  return out;
}
