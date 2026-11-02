import { describe, expect, it } from "vitest";
import { runTransferQueue, transferWaves } from "../src/execution/transfer-waves";
import type { SyncPlanItem, SyncPlanStep } from "../src/planner/types";
import type { FileReplicaRecord } from "../src/state/durable/model";

const limits = { workers: 4, bytes: 10_000, chunkBytes: 100 };

function file(id: string, path: string, size = 10, remoteId: string | null = `remote-${id}`): FileReplicaRecord {
  return {
    entryId: id, generation: "1", path, status: "local-dirty", baseline: null,
    local: { path, contentHash: "a".repeat(64), size, mtimeMs: 1 },
    remote: { path, contentHash: null, reportedSha256: null, etag: '"e1"', fileId: remoteId, size, mtimeMs: 1 }
  };
}

function item(id: string, path: string, kind: SyncPlanStep["kind"] = "upload-update", extra: SyncPlanStep[] = []): SyncPlanItem {
  const transfer: SyncPlanStep = { kind, sourcePath: path, targetPath: path, destructive: false, requiresFreshRemoteEtag: false, description: kind };
  return {
    entryId: id, displayPath: path, localPath: path, remotePath: path, baselinePath: path,
    classification: "local-change", disposition: "ready", reasons: [], steps: [transfer, ...extra],
    localChanged: true, remoteChanged: false, localPathChanged: false, remotePathChanged: false,
    remoteIdentityChanged: false, remoteContentKnown: true
  };
}

function map(...records: FileReplicaRecord[]): Map<string, FileReplicaRecord> {
  return new Map(records.map((record) => [record.entryId, record]));
}

describe("transfer waves", () => {
  it("groups independent transfers concurrently and preserves plan order", () => {
    const items = [item("a", "A.md"), item("b", "B.md"), item("c", "C.md")];
    const waves = transferWaves(items, map(file("a", "A.md"), file("b", "B.md"), file("c", "C.md")), limits);
    expect(waves).toEqual([items]);
  });

  it("respects both the worker cap and estimated in-flight byte budget", () => {
    const items = [item("a", "A.md"), item("b", "B.md"), item("c", "C.md")];
    const records = map(file("a", "A.md"), file("b", "B.md"), file("c", "C.md"));
    expect(transferWaves(items, records, { ...limits, workers: 2 }).map((wave) => wave.map((entry) => entry.entryId)))
      .toEqual([["a", "b"], ["c"]]);
    expect(transferWaves(items, records, { ...limits, bytes: 50 }).map((wave) => wave.map((entry) => entry.entryId)))
      .toEqual([["a"], ["b"], ["c"]]);
  });

  it("serializes normalized path aliases and parent/child paths", () => {
    const items = [item("a", "Folder/Note.md"), item("b", "folder/note.md"), item("c", "Folder")];
    const records = map(file("a", "Folder/Note.md"), file("b", "folder/note.md"), file("c", "Folder"));
    expect(transferWaves(items, records, limits).map((wave) => wave.map((entry) => entry.entryId)))
      .toEqual([["a"], ["b"], ["c"]]);
  });

  it("serializes distinct entries that refer to the same remote identity", () => {
    const items = [item("a", "A.md"), item("b", "B.md")];
    const records = map(file("a", "A.md", 10, "same-id"), file("b", "B.md", 10, "same-id"));
    expect(transferWaves(items, records, limits).map((wave) => wave.map((entry) => entry.entryId)))
      .toEqual([["a"], ["b"]]);
  });

  it("keeps a remote replica without proven identity or ETag serial", () => {
    const items = [item("a", "A.md"), item("b", "B.md")];
    const missingIdentity = file("a", "A.md", 10, null);
    expect(transferWaves(items, map(missingIdentity, file("b", "B.md")), limits)).toEqual([[items[0]], [items[1]]]);
    const missingEtag = file("a", "A.md");
    missingEtag.remote!.etag = null;
    expect(transferWaves(items, map(missingEtag, file("b", "B.md")), limits)).toEqual([[items[0]], [items[1]]]);
  });

  it("places move, delete, and multi-step items behind transfer barriers", () => {
    const items = [
      item("a", "A.md"), item("move", "Old.md", "move-local"), item("b", "B.md"),
      item("delete", "Gone.md", "delete-remote"), item("c", "C.md"),
      item("multi", "Multi.md", "upload-create", [{ kind: "verify-remote-content", sourcePath: "Multi.md", targetPath: null, destructive: false, requiresFreshRemoteEtag: false, description: "verify" }])
    ];
    const records = map(...items.map((entry) => file(entry.entryId, entry.displayPath)));
    expect(transferWaves(items, records, limits).map((wave) => wave.map((entry) => entry.entryId)))
      .toEqual([["a"], ["move"], ["b"], ["delete"], ["c"], ["multi"]]);
  });

  it("keeps unknown entries serial and rejects invalid limits", () => {
    const a = item("a", "A.md");
    const b = item("missing", "B.md");
    expect(transferWaves([a, b, a], map(file("a", "A.md")), limits)).toEqual([[a], [b], [a]]);
    expect(() => transferWaves([a], map(file("a", "A.md")), { ...limits, workers: 0 })).toThrow(/positive safe integers/);
  });
});

describe("dynamic transfer queue", () => {
  it("waits for path or remote-identity conflicts before admitting the next job", async () => {
    for (const scenario of ["path", "identity"] as const) {
      const a = item("a", "Folder/Note.md"), b = item("b", scenario === "path" ? "folder/note.md" : "Other.md");
      const records = map(file("a", a.displayPath, 10, "same"), file("b", b.displayPath, 10, scenario === "identity" ? "same" : "other"));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started: string[] = [];
      const running = runTransferQueue([a, b], records, limits, async (entry) => {
        started.push(entry.entryId);
        if (entry.entryId === "a") await gate;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(started).toEqual(["a"]);
      release();
      await running;
      expect(started).toEqual(["a", "b"]);
    }
  });

  it("enforces estimated memory limits and does not overtake a conflicting or exclusive item", async () => {
    const items = [item("a", "A.md"), item("b", "B.md"), item("move", "Old.md", "move-local"), item("c", "C.md")];
    const records = map(...items.map((entry) => file(entry.entryId, entry.displayPath)));
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    const running = runTransferQueue(items, records, { ...limits, workers: 3, bytes: 100 }, async (entry) => {
      started.push(entry.entryId);
      await new Promise<void>((resolve) => gates.set(entry.entryId, resolve));
      return entry.entryId;
    });
    const tick = async () => await new Promise((resolve) => setTimeout(resolve, 0));
    await tick(); expect(started).toEqual(["a", "b"]);
    gates.get("b")!(); await tick(); expect(started).toEqual(["a", "b"]);
    gates.get("a")!(); await tick(); expect(started).toEqual(["a", "b", "move"]);
    gates.get("move")!(); await tick(); expect(started).toEqual(["a", "b", "move", "c"]);
    gates.get("c")!(); expect(await running).toEqual(["a", "b", "move", "c"]);
  });

  it("starts the next independent job when a worker becomes free, without waiting for the slowest", async () => {
    const items = [item("a", "A.md"), item("b", "B.md"), item("c", "C.md")];
    const records = map(...items.map((entry) => file(entry.entryId, entry.displayPath)));
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    let thirdStarted!: () => void;
    const third = new Promise<void>((resolve) => { thirdStarted = resolve; });
    const running = runTransferQueue(items, records, { ...limits, workers: 2 }, async (entry) => {
      started.push(entry.entryId);
      if (entry.entryId === "c") thirdStarted();
      await new Promise<void>((resolve) => gates.set(entry.entryId, resolve));
      return entry.entryId;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b"]);
    gates.get("b")!();
    await third;
    expect(started).toEqual(["a", "b", "c"]);
    gates.get("c")!(); gates.get("a")!();
    expect(await running).toEqual(["a", "b", "c"]);
  });

  it("does not start pending work after a failure and drains active jobs", async () => {
    const items = [item("a", "A.md"), item("b", "B.md"), item("c", "C.md")];
    const records = map(...items.map((entry) => file(entry.entryId, entry.displayPath)));
    let release!: () => void, fail!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const error = new Promise<void>((_, reject) => { fail = () => reject(new Error("failed")); });
    const started: string[] = [];
    const running = runTransferQueue(items, records, { ...limits, workers: 2 }, async (entry) => {
      started.push(entry.entryId);
      await (entry.entryId === "a" ? error : blocked);
    }).then(() => null, (reason: Error) => reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["a", "b"]);
    release();
    expect((await running)?.message).toBe("failed");
    expect(started).toEqual(["a", "b"]);
  });
});
