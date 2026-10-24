import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { TransactionalSyncExecutor } from "../src/execution/executor";
import type { LocalTransactionalMutator, LocalWriteResult, PreparedLocalSnapshot } from "../src/execution/local-mutator";
import type { RemoteDownloadStream, RemoteTransactionalMutator } from "../src/execution/remote-mutator";
import { SyncPlanner } from "../src/planner/planner";
import { sha256Hex } from "../src/state/durable/crypto";
import { DurableStateStore } from "../src/state/durable/store";
import type { RemoteReplicaState } from "../src/state/durable/model";
import type { TransferTuning } from "../src/transfer/types";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const tuning: TransferTuning = { chunkUploadThresholdBytes: 5*1024*1024, uploadChunkBytes: 5*1024*1024, downloadRangeChunkBytes: 1024*1024, maxWholeDownloadBytes: 5*1024*1024 };
const enc = new TextEncoder(); const dec = new TextDecoder();

describe("Multi-device convergence", () => {
  it("merges independent Markdown edits and advances BASE", async () => {
    const base = enc.encode("A\nB\nC\nD\n").buffer;
    let localBytes = enc.encode("A\nLOCAL\nC\nD\n").buffer;
    let remoteBytes = enc.encode("A\nB\nC\nREMOTE\n").buffer;
    const baseHash = await sha256Hex(base), localHash = await sha256Hex(localBytes), remoteHash = await sha256Hex(remoteBytes);
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    await store.putBlob(base);
    await store.transact("seed-stage11", (tx) => tx.putFile({
      entryId:"file_merge", path:"Notes/Merge.md", status:"conflict", baseline:{ blobHash:baseHash,size:base.byteLength,createdAt:new Date().toISOString(),path:"Notes/Merge.md",remoteFileId:"77",remoteEtag:'"base"' },
      local:{ path:"Notes/Merge.md",contentHash:localHash,size:localBytes.byteLength,mtimeMs:10 },
      remote:{ path:"Notes/Merge.md",contentHash:remoteHash,reportedSha256:null,etag:'"remote"',fileId:"77",size:remoteBytes.byteLength,mtimeMs:11 }
    }));
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.disposition).toBe("merge-candidate");
    expect(plan.items[0]?.steps.map((s) => s.kind)).toEqual(["merge-text","establish-baseline"]);

    const local = makeLocal(() => localBytes, (next) => { localBytes = next; });
    const remote = makeRemote(() => remoteBytes, (next) => { remoteBytes = next; });
    const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.test/dav/files/u/", "Obsidian", tuning, logger);
    const report = await executor.execute(plan, { allowDestructive:false, allowMerge:true, mergeLimits:{maxInputBytes:2*1024*1024,maxLines:12000,maxDiffCells:8_000_000}, maxOperations:20 });
    expect(report.failed).toBe(0); expect(report.blocked).toBe(0); expect(report.mergedFiles).toBe(1);
    expect(dec.decode(localBytes)).toBe("A\nLOCAL\nC\nREMOTE\n");
    expect(dec.decode(remoteBytes)).toBe("A\nLOCAL\nC\nREMOTE\n");
    const record = store.getState().files.file_merge!;
    expect(record.status).toBe("clean");
    expect(record.baseline?.blobHash).toBe(record.local?.contentHash);
    expect(record.remote?.contentHash).toBe(record.local?.contentHash);
  });

  it("blocks overlapping edits without mutating either replica", async () => {
    const base = enc.encode("A\nB\n").buffer;
    let localBytes = enc.encode("A\nLOCAL\n").buffer;
    let remoteBytes = enc.encode("A\nREMOTE\n").buffer;
    const store = await seeded(storeBackend(), base, localBytes, remoteBytes);
    const plan = await new SyncPlanner().build(store.getState());
    let writes = 0;
    const local = makeLocal(() => localBytes, (next) => { writes++; localBytes = next; });
    const remote = makeRemote(() => remoteBytes, (next) => { writes++; remoteBytes = next; });
    const executor = new TransactionalSyncExecutor(store, local, remote, "https://cloud.test/dav/files/u/", "Obsidian", tuning, logger);
    const report = await executor.execute(plan, { allowDestructive:false, allowMerge:true, maxOperations:20 });
    expect(report.mergeConflicts).toBe(1); expect(report.blocked > 0).toBe(true); expect(writes).toBe(0);
  });

  it("plans path convergence after a one-sided rename plus dual content edits", async () => {
    const stateStore = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base=enc.encode("A\nB\nC\n").buffer, local=enc.encode("A\nL\nC\n").buffer, remote=enc.encode("A\nB\nR\n").buffer;
    const bh=await sha256Hex(base), lh=await sha256Hex(local), rh=await sha256Hex(remote); await stateStore.putBlob(base);
    await stateStore.transact("rename+merge", tx=>tx.putFile({ entryId:"file_xxxxxxx",path:"Archive/X.md",status:"conflict",baseline:{blobHash:bh,size:base.byteLength,createdAt:new Date().toISOString(),path:"Notes/X.md",remoteFileId:"9",remoteEtag:'"b"'},local:{path:"Archive/X.md",contentHash:lh,size:local.byteLength,mtimeMs:2},remote:{path:"Notes/X.md",contentHash:rh,reportedSha256:null,etag:'"r"',fileId:"9",size:remote.byteLength,mtimeMs:3} }));
    const plan=await new SyncPlanner().build(stateStore.getState());
    expect(plan.items[0]?.steps.map(s=>s.kind)).toEqual(["merge-text","move-remote","establish-baseline"]);
  });
});

function storeBackend(): MemoryStateBackend { return new MemoryStateBackend(); }
async function seeded(backend: MemoryStateBackend, base:ArrayBuffer, local:ArrayBuffer, remote:ArrayBuffer): Promise<DurableStateStore> {
  const store=await DurableStateStore.open(backend,logger); const bh=await sha256Hex(base), lh=await sha256Hex(local), rh=await sha256Hex(remote); await store.putBlob(base);
  await store.transact("seed", tx=>tx.putFile({ entryId:"file_merge",path:"Notes/Merge.md",status:"conflict",baseline:{blobHash:bh,size:base.byteLength,createdAt:new Date().toISOString(),path:"Notes/Merge.md",remoteFileId:"77",remoteEtag:'"base"'},local:{path:"Notes/Merge.md",contentHash:lh,size:local.byteLength,mtimeMs:1},remote:{path:"Notes/Merge.md",contentHash:rh,reportedSha256:null,etag:'"remote"',fileId:"77",size:remote.byteLength,mtimeMs:2} })); return store;
}
function makeLocal(get:()=>ArrayBuffer,set:(b:ArrayBuffer)=>void): LocalTransactionalMutator {
  return {
    async readVerified(path:string, expected:string){ const bytes=get(); expect(await sha256Hex(bytes)).toBe(expected); return {path,bytes:bytes.slice(0),contentHash:expected,size:bytes.byteLength,mtimeMs:1}; },
    async writeAtomic(path:string, bytes:ArrayBuffer, expected:string|null):Promise<LocalWriteResult>{ if(expected) expect(await sha256Hex(get())).toBe(expected); const copy=bytes.slice(0); set(copy); return {path,contentHash:await sha256Hex(copy),size:copy.byteLength,mtimeMs:3}; },
    async prepareSnapshot(path:string, expected:string):Promise<PreparedLocalSnapshot>{ const bytes=get().slice(0); expect(await sha256Hex(bytes)).toBe(expected); return snapshot(path,bytes,expected); }
  } as unknown as LocalTransactionalMutator;
}
function makeRemote(get:()=>ArrayBuffer,set:(b:ArrayBuffer)=>void): RemoteTransactionalMutator {
  return {
    async openDownload(_url:string,path:string,fileId:string|null,etag:string|null):Promise<RemoteDownloadStream>{ const bytes=get().slice(0); const hash=await sha256Hex(bytes); const remote:RemoteReplicaState={path,contentHash:hash,reportedSha256:null,etag,fileId,size:bytes.byteLength,mtimeMs:2}; return {chunks:(async function*(){yield bytes;})(),completed:Promise.resolve({contentHash:hash,remote,bytesTransferred:bytes.byteLength,ranged:false})}; },
    async uploadUpdate(_url:string,path:string,bytes:ArrayBuffer,fileId:string|null,_etag:string|null){ const copy=bytes.slice(0); set(copy); const hash=await sha256Hex(copy); return {bytes:copy,contentHash:hash,remote:{path,contentHash:hash,reportedSha256:null,etag:'"merged"',fileId,size:copy.byteLength,mtimeMs:4}}; }
  } as unknown as RemoteTransactionalMutator;
}
function snapshot(path:string,bytes:ArrayBuffer,hash:string):PreparedLocalSnapshot { return {snapshotId:"s",path,contentHash:hash,size:bytes.byteLength,mtimeMs:3,chunkSize:Math.max(1,bytes.byteLength),chunkCount:1,async readChunk(i){if(i!==0)throw new Error("bad");return bytes.slice(0);},async *chunks(){yield bytes.slice(0);},async assertSourceUnchanged(){expect(await sha256Hex(bytes)).toBe(hash);},async cleanup(){}}; }
