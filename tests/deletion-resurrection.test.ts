import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalInventoryReconciler } from "../src/local/reconciler";
import { RemoteInventoryReconciler } from "../src/remote/reconciler";
import { SyncPlanner } from "../src/planner/planner";
import type { RemoteFullScanResult } from "../src/remote/types";
import { DurableStateStore } from "../src/state/durable/store";
import { randomId } from "../src/state/durable/ids";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const path = "Deleted folder/Nested/note.md";

describe("Deletion before first BASE", () => {
  for (const side of ["local", "remote"] as const) it(`does not recreate a ${side} deletion after restart and repeated scans`, async () => {
    const backend = new MemoryStateBackend();
    let store = await DurableStateStore.open(backend, logger);
    const blob = await store.putTextBlob("unbaselined content");
    await store.transact("seed-partially-converged", (tx) => tx.putFile({
      entryId: randomId("pending"), path, baseline: null, status: "both-dirty",
      local: { path, contentHash: blob.hash, size: blob.size, mtimeMs: 1 },
      remote: { path, contentHash: blob.hash, reportedSha256: null, etag: '"r1"', fileId: "1", size: blob.size, mtimeMs: 1 }
    }));
    const remoteScan: RemoteFullScanResult = {
      kind: "full", rootPath: "", entries: [], directories: [], oversized: [], rootEtag: null, directoriesVisited: 1,
      trust: "authoritative", complete: true, issues: [], startedAt: "2026-10-18T00:00:00.000Z", finishedAt: "2026-10-18T00:00:00.001Z"
    };
    const observeDeletion = async () => {
      if (side === "local") {
        await new LocalInventoryReconciler(store).applyFullScan({
          kind: "full", entries: [], complete: true, issues: [], oversized: [], hashedBytes: 0, renameCandidates: [],
          startedAt: remoteScan.startedAt, finishedAt: remoteScan.finishedAt
        }, { exactRenames: [], allowNewRecords: true });
      } else {
        await new RemoteInventoryReconciler(store).applyFullScan(remoteScan);
      }
    };
    await observeDeletion();
    await store.close();
    store = await DurableStateStore.open(backend, logger);
    for (let cycle = 0; cycle < 3; cycle++) {
      await observeDeletion();
      const plan = await new SyncPlanner().build(store.getState());
      expect(plan.items[0]?.classification).toBe("delete-vs-change");
      expect(plan.items[0]?.disposition).toBe("blocked");
      expect(plan.items[0]?.steps.map((step) => step.kind)).toEqual(["manual-resolution"]);
      expect(Object.values(store.getState().tombstones)).toHaveLength(1);
    }
  });
});
