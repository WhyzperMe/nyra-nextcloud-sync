import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import type { PreparedLocalSnapshot } from "../src/execution/local-mutator";
import { RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { sha256Hex } from "../src/state/durable/crypto";
import { chunkBounds, planNextcloudChunks } from "../src/transfer/chunking";
import { IncrementalSha256 } from "../src/transfer/incremental-sha256";
import { TransferJournalStore } from "../src/transfer/journal";
import type { TransferTuning } from "../src/transfer/types";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { makeMemoryVault } from "./helpers/memory-vault";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEVICE_SCOPE = "f".repeat(32);
const MIB = 1024 * 1024;
const tuning: TransferTuning = {
  chunkUploadThresholdBytes: 5 * MIB,
  uploadChunkBytes: 5 * MIB,
  downloadRangeChunkBytes: 2 * MIB,
  maxWholeDownloadBytes: 5 * MIB
};

describe("Resumable transfer regression", () => {
  it("matches standard SHA-256 vectors incrementally", () => {
    const h = new IncrementalSha256();
    h.update(new TextEncoder().encode("a"));
    h.update(new TextEncoder().encode("bc"));
    expect(h.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("resumes a v2 chunk upload after an injected network failure and verifies by ranged GET", async () => {
    const server = "https://cloud.example.test";
    const userId = "u";
    const dav = new FakeNextcloudDav(server, userId);
    const vault = makeMemoryVault();
    const journal = new TransferJournalStore(vault, "nyra-nextcloud-sync", logger, DEVICE_SCOPE);
    await journal.ensure();
    const bytes = patterned(6 * MIB + 123);
    const hash = await sha256Hex(bytes.buffer);
    const geometry = planNextcloudChunks(bytes.byteLength, tuning.uploadChunkBytes);
    const snapshot = makeSnapshot(bytes, hash, geometry.chunkSize);
    const options = {
      serverUrl: server, userId,
      webdavUserRoot: `${server}/remote.php/dav/files/${userId}/`,
      tuning, journal, maxAttempts: 1
    };
    const credentials = { serverUrl: server, loginName: userId, appPassword: "test-app-password" };
    const targetPath = "Large.bin";
    const targetUrl = `${server}/remote.php/dav/files/${userId}/Obsidian/${targetPath}`;

    dav.failChunkName = "00002";
    const first = new RemoteTransactionalMutator(dav, credentials, logger, options);
    await expect(first.uploadCreateFromSnapshot(targetUrl, targetPath, snapshot)).rejects.toThrow(/Injected chunk transport failure/);
    const interrupted = await journal.listLatest();
    expect(interrupted.length).toBe(1);
    expect(interrupted[0]?.uploadedChunks).toEqual([0]);

    dav.failChunkName = null;
    const second = new RemoteTransactionalMutator(dav, credentials, logger, options);
    const result = await second.uploadCreateFromSnapshot(targetUrl, targetPath, snapshot);
    expect(result.chunked).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.contentHash).toBe(hash);
    expect(result.remote.contentHash).toBe(hash);
    expect(result.remote.size).toBe(bytes.byteLength);
    expect(dav.rangeGets > 0).toBe(true);
    expect((await journal.listLatest()).length).toBe(0);
    const actual = dav.getFile(targetUrl);
    expect(actual !== null).toBe(true);
    expect(await sha256Hex(actual!)).toBe(hash);
  });
});

function makeSnapshot(data: Uint8Array, hash: string, chunkSize: number): PreparedLocalSnapshot {
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / chunkSize));
  return {
    snapshotId: "snapshot-regression",
    path: "Large.bin",
    contentHash: hash,
    size: data.byteLength,
    mtimeMs: 1,
    chunkSize,
    chunkCount,
    async readChunk(index: number) {
      const b = chunkBounds(index, data.byteLength, chunkSize);
      const out = new Uint8Array(b.size); out.set(data.subarray(b.start, b.endExclusive)); return out.buffer;
    },
    async *chunks() { for (let i=0;i<chunkCount;i+=1) yield await this.readChunk(i); },
    async assertSourceUnchanged() {},
    async cleanup() {}
  };
}
function patterned(size: number): Uint8Array { const out=new Uint8Array(size);for(let i=0;i<size;i+=1)out[i]=(i*31+7)&0xff;return out; }
