import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { SyncPlanner } from "../src/planner/planner";
import { SyncPlannerService } from "../src/planner/service";
import { randomId } from "../src/state/durable/ids";
import type { BaselineRef, FileReplicaInput } from "../src/state/durable/model";
import { DurableStateStore } from "../src/state/durable/store";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function seed(store: DurableStateStore, record: Omit<FileReplicaInput, "entryId">): Promise<string> {
  const entryId = randomId("entry");
  await store.transact("planner-test-seed", (tx) => tx.putFile({ entryId, ...record }));
  return entryId;
}

async function baseline(store: DurableStateStore, path: string, text = "base"): Promise<BaselineRef> {
  const blob = await store.putTextBlob(text);
  return { blobHash: blob.hash, size: blob.size, createdAt: new Date().toISOString(), path, remoteFileId: "remote-1", remoteEtag: '"base"' };
}

describe("Deterministic sync planner", () => {
  it("keeps local and remote paths independent and plans a local rename", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base = await baseline(store, "Old.md");
    await seed(store, {
      path: "New.md",
      baseline: base,
      local: { path: "New.md", contentHash: base.blobHash, size: base.size, mtimeMs: 2 },
      remote: { path: "Old.md", contentHash: null, reportedSha256: null, etag: '"base"', fileId: "remote-1", size: base.size, mtimeMs: 1 },
      status: "local-dirty"
    });
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.classification).toBe("local-change");
    expect(plan.items[0]?.steps[0]?.kind).toBe("move-remote");
    expect(plan.items[0]?.localPath).toBe("New.md");
    expect(plan.items[0]?.remotePath).toBe("Old.md");
  });

  it("requires trusted remote verification when baseline anchors cannot prove content", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base = await baseline(store, "Note.md");
    base.remoteEtag = null;
    await seed(store, {
      path: "Note.md",
      baseline: base,
      local: { path: "Note.md", contentHash: base.blobHash, size: base.size, mtimeMs: 1 },
      remote: { path: "Note.md", contentHash: null, reportedSha256: "a".repeat(64), etag: '"server"', fileId: "remote-1", size: base.size, mtimeMs: 1 },
      status: "remote-dirty"
    });
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.disposition).toBe("needs-verification");
    expect(plan.items[0]?.steps[0]?.kind).toBe("verify-remote-content");
  });

  it("blocks delete-versus-modify instead of guessing", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base = await baseline(store, "Conflict.md");
    await seed(store, {
      path: "Conflict.md",
      baseline: base,
      local: null,
      remote: { path: "Conflict.md", contentHash: "c".repeat(64), reportedSha256: null, etag: '"changed"', fileId: "remote-1", size: base.size, mtimeMs: 2 },
      status: "both-dirty"
    });
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.classification).toBe("delete-vs-change");
    expect(plan.items[0]?.disposition).toBe("blocked");
  });

  it("recognizes orthogonal local rename and remote content edit", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base = await baseline(store, "Old.md");
    await seed(store, {
      path: "New.md",
      baseline: base,
      local: { path: "New.md", contentHash: base.blobHash, size: base.size, mtimeMs: 2 },
      remote: { path: "Old.md", contentHash: "d".repeat(64), reportedSha256: null, etag: '"changed"', fileId: "remote-1", size: base.size, mtimeMs: 3 },
      status: "both-dirty"
    });
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.items[0]?.classification).toBe("orthogonal-rename-content");
    expect(plan.items[0]?.disposition).toBe("ready");
    expect(plan.items[0]?.steps.map((step) => step.kind)).toContain("move-remote");
    expect(plan.items[0]?.steps.map((step) => step.kind)).toContain("download-update");
  });



  it("verifies same-path remote identity replacement and then refreshes only the baseline anchor", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const base = await baseline(store, "Stable.md");
    base.remoteFileId = "old-id";
    base.remoteEtag = '"old-etag"';
    const entryId = await seed(store, {
      path: "Stable.md", baseline: base,
      local: { path: "Stable.md", contentHash: base.blobHash, size: base.size, mtimeMs: 1 },
      remote: { path: "Stable.md", contentHash: null, reportedSha256: null, etag: '"new-etag"', fileId: "new-id", size: base.size, mtimeMs: 2 },
      status: "remote-dirty"
    });
    const planner = new SyncPlanner();
    const before = await planner.build(store.getState());
    expect(before.items[0]?.classification).toBe("needs-remote-verification");
    expect(before.items[0]?.remoteIdentityChanged).toBe(true);

    await store.transact("trusted-replacement", (tx, state) => {
      const record = structuredClone(state.files[entryId]!);
      record.remote!.contentHash = base.blobHash;
      tx.putFile({ entryId: record.entryId, path: record.path, baseline: record.baseline, local: record.local, remote: record.remote, status: record.status });
    });
    const after = await planner.build(store.getState());
    expect(after.items[0]?.classification).toBe("remote-change");
    expect(after.items[0]?.disposition).toBe("ready");
    expect(after.items[0]?.steps.map((step) => step.kind)).toEqual(["establish-baseline"]);
  });

  it("represents cross-side same-path identity collisions and blocks both records", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    await seed(store, {
      path: "Same.md",
      baseline: null,
      local: { path: "Same.md", contentHash: "1".repeat(64), size: 1, mtimeMs: 1 },
      remote: null,
      status: "local-dirty"
    });
    await seed(store, {
      path: "Same.md",
      baseline: null,
      local: null,
      remote: { path: "Same.md", contentHash: null, reportedSha256: null, etag: '"x"', fileId: "different-remote", size: 1, mtimeMs: 1 },
      status: "remote-dirty"
    });
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.summary.blocked).toBe(2);
    expect(plan.items[0]?.classification).toBe("path-identity-collision");
    expect(plan.items[1]?.classification).toBe("path-identity-collision");
  });

  it("produces the same fingerprint for the same immutable state", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    await seed(store, {
      path: "A.md",
      baseline: null,
      local: { path: "A.md", contentHash: "2".repeat(64), size: 1, mtimeMs: 1 },
      remote: null,
      status: "local-dirty"
    });
    const planner = new SyncPlanner();
    const a = await planner.build(store.getState());
    const b = await planner.build(store.getState());
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("marks a published plan stale after durable state advances", async () => {
    const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
    const service = new SyncPlannerService(store, logger);
    await seed(store, {
      path: "A.md",
      baseline: null,
      local: { path: "A.md", contentHash: "3".repeat(64), size: 1, mtimeMs: 1 },
      remote: null,
      status: "local-dirty"
    });
    await service.buildPlan();
    await seed(store, {
      path: "B.md",
      baseline: null,
      local: { path: "B.md", contentHash: "4".repeat(64), size: 1, mtimeMs: 1 },
      remote: null,
      status: "local-dirty"
    });
    expect(service.summary().status).toBe("stale");
    expect(service.currentPlan()).toBeNull();
  });
});
