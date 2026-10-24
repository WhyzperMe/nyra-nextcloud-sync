import { describe, expect, it } from "vitest";
import { SyncPlanner } from "../src/planner/planner";
import { deriveFileSyncStatus, remoteContentRelation } from "../src/sync/derived-status";
import type { Logger } from "../src/diagnostics/logger";
import { DurableStateStore } from "../src/state/durable/store";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("Reused ETag with changed content length", () => {
  it("blocks local deletion versus a changed remote even when the server reuses its ETag", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base = await store.putTextBlob("base");
    await store.transact("changed-size-reused-etag", (tx) => tx.putFile({
      entryId: "entry-reused-etag", path: "note.md", local: null, status: "pending-delete",
      baseline: { blobHash: base.hash, size: base.size, createdAt: new Date().toISOString(), path: "note.md", remoteFileId: "123", remoteEtag: '"same"' },
      remote: { path: "note.md", contentHash: null, reportedSha256: null, etag: '"same"', fileId: "123", size: 8, mtimeMs: 1 }
    }));
    const state = store.getState(); const record = state.files["entry-reused-etag"]!;
    expect(remoteContentRelation(record)).toBe("different");
    expect(deriveFileSyncStatus(record)).toBe("both-dirty");
    const plan = await new SyncPlanner().build(state);
    expect(plan.items[0]?.classification).toBe("delete-vs-change");
    expect(plan.items[0]?.disposition).toBe("blocked");
    expect(plan.summary.destructiveSteps).toBe(0);
    await store.close();
  });

  it("does not let a cached hash or unchanged ETag hide contradictory byte lengths", () => {
    const baseline = { blobHash: "a".repeat(64), size: 4, createdAt: new Date().toISOString(), path: "note.md", remoteFileId: "123", remoteEtag: '"same"' };
    const remote = { path: "note.md", contentHash: baseline.blobHash, reportedSha256: null, etag: '"same"', fileId: "123", size: 8, mtimeMs: 1 };
    expect(remoteContentRelation({ baseline, remote })).toBe("different");
    expect(remoteContentRelation({ baseline, remote: { ...remote, size: 4 } })).toBe("same");
  });
});
