import { describe, expect, it } from "vitest";
import { ConvergenceAuditor, auditConvergenceState } from "../src/convergence/auditor";
import type { Logger } from "../src/diagnostics/logger";
import { sha256Hex } from "../src/state/durable/crypto";
import { createEmptyState, type FileReplicaRecord } from "../src/state/durable/model";
import { DurableStateStore } from "../src/state/durable/store";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const enc = new TextEncoder();

describe("Convergence audit", () => {
  it("accepts a semantically clean LOCAL/BASE/REMOTE record", async () => {
    const bytes = enc.encode("clean\n").buffer;
    const hash = await sha256Hex(bytes);
    const state = createEmptyState("store_stage12_clean");
    const record = cleanRecord(hash, bytes.byteLength);
    state.files[record.entryId] = record;
    state.pathIndex[record.local!.path] = record.entryId;
    state.remotePathIndex[record.remote!.path] = record.entryId;
    state.remoteFileIdIndex[record.remote!.fileId!] = record.entryId;
    const report = auditConvergenceState(state);
    expect(report.status).toBe("healthy");
    expect(report.errors).toBe(0);
    expect(report.verifiedCleanRecords).toBe(1);
  });

  it("fails closed when a record claims clean while LOCAL differs from BASE", async () => {
    const base = enc.encode("base\n").buffer;
    const changed = enc.encode("changed\n").buffer;
    const baseHash = await sha256Hex(base);
    const changedHash = await sha256Hex(changed);
    const state = createEmptyState("store_stage12_badclean");
    const record = cleanRecord(baseHash, base.byteLength);
    record.local = { ...record.local!, contentHash: changedHash, size: changed.byteLength };
    record.status = "clean";
    state.files[record.entryId] = record;
    state.pathIndex[record.local.path] = record.entryId;
    state.remotePathIndex[record.remote!.path] = record.entryId;
    state.remoteFileIdIndex[record.remote!.fileId!] = record.entryId;
    const report = auditConvergenceState(state);
    expect(report.status).toBe("attention");
    expect(report.issues.some((issue) => issue.code === "clean-local-hash-mismatch")).toBe(true);
  });

  it("deep-audits the immutable BASE object", async () => {
    const bytes = enc.encode("deep\n").buffer;
    const hash = await sha256Hex(bytes);
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    await store.putBlob(bytes);
    await store.transact("seed-stage12-clean", (tx) => tx.putFile({
      entryId: "file_stage12_deep",
      path: "Notes/A.md",
      baseline: { blobHash: hash, size: bytes.byteLength, createdAt: new Date().toISOString(), path: "Notes/A.md", remoteFileId: "71", remoteEtag: '"e1"' },
      local: { path: "Notes/A.md", contentHash: hash, size: bytes.byteLength, mtimeMs: 1 },
      remote: { path: "Notes/A.md", contentHash: hash, reportedSha256: null, etag: '"e1"', fileId: "71", size: bytes.byteLength, mtimeMs: 1 },
      status: "clean"
    }));
    const report = await new ConvergenceAuditor(store).audit({ mode: "deep" });
    expect(report.status).toBe("healthy");
    expect(report.errors).toBe(0);
  });
});

function cleanRecord(hash: string, size: number): FileReplicaRecord {
  return {
    entryId: "file_stage12_clean",
    path: "Notes/A.md",
    generation: "0",
    baseline: { blobHash: hash, size, createdAt: "2026-01-01T00:00:00.000Z", path: "Notes/A.md", remoteFileId: "71", remoteEtag: '"e1"' },
    local: { path: "Notes/A.md", contentHash: hash, size, mtimeMs: 1 },
    remote: { path: "Notes/A.md", contentHash: hash, reportedSha256: null, etag: '"e1"', fileId: "71", size, mtimeMs: 1 },
    status: "clean"
  };
}
