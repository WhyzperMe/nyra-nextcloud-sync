import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { randomId } from "../src/state/durable/ids";
import { ObjectStore } from "../src/state/durable/object-store";
import { DurableStateStore } from "../src/state/durable/store";
import { WalJournal } from "../src/state/durable/wal";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

class AmbiguousCommitBackend extends MemoryStateBackend {
  private walRenames = 0;
  private ambiguousPath: string | null = null;
  private forcedReadFailures = 0;

  override async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to);
    if (!to.startsWith("wal/") || !to.endsWith(".wal.json")) return;
    this.walRenames += 1;
    // WAL rename #1 = genesis, #2 = transaction begin, #3 = commit.
    if (this.walRenames === 3) {
      this.ambiguousPath = to;
      this.forcedReadFailures = 2;
      throw new Error("simulated adapter error after durable rename");
    }
  }

  override async readText(path: string): Promise<string> {
    if (path === this.ambiguousPath && this.forcedReadFailures > 0) {
      this.forcedReadFailures -= 1;
      throw new Error("simulated transient read-back failure");
    }
    return await super.readText(path);
  }
}

class MeasuringInventoryBackend extends MemoryStateBackend {
  activeStats = 0;
  maxConcurrentStats = 0;
  statCalls = 0;

  override async statSize(path: string): Promise<number | null> {
    this.statCalls += 1;
    this.activeStats += 1;
    this.maxConcurrentStats = Math.max(this.maxConcurrentStats, this.activeStats);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await super.statSize(path);
    } finally {
      this.activeStats -= 1;
    }
  }
}

class GenerationPublicationFailureBackend extends MemoryStateBackend {
  failNextGenerationRename = false;
  failAfterGenerationRename = false;
  failDuringGenerationWrite = false;

  override async writeText(path: string, data: string): Promise<void> {
    if (this.failDuringGenerationWrite && path.startsWith("generations/") && path.endsWith(".tmp")) {
      this.failDuringGenerationWrite = false;
      await super.writeText(path, data.slice(0, Math.max(1, Math.floor(data.length / 2))));
      throw new Error("simulated interruption during generation manifest write");
    }
    await super.writeText(path, data);
  }

  override async rename(from: string, to: string): Promise<void> {
    if (this.failNextGenerationRename && to.startsWith("generations/")) {
      this.failNextGenerationRename = false;
      throw new Error("simulated crash before generation publication");
    }
    await super.rename(from, to);
    if (this.failAfterGenerationRename && to.startsWith("generations/")) {
      this.failAfterGenerationRename = false;
      throw new Error("simulated adapter error after generation publication");
    }
  }
}

describe("Durable state", () => {
  it("removes only abandoned object staging files on open", async () => {
    const backend = new MemoryStateBackend();
    await backend.writeText(`objects/.staging/blob_${"a".repeat(32)}.tmp`, "partial chunk stream");
    await backend.writeText("objects/.staging/keep.marker", "not a Nyra staging name");

    await DurableStateStore.open(backend, logger);

    expect(await backend.exists(`objects/.staging/blob_${"a".repeat(32)}.tmp`)).toBe(false);
    expect(await backend.exists("objects/.staging/keep.marker")).toBe(true);
  });

  it("bounds verified snapshot growth and recovers through retained checkpoints and the full WAL", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    for (let index = 0; index < 64; index += 1) {
      await store.transact("snapshot-retention-test", (tx) => tx.putTombstone({
        tombstoneId: randomId("tomb"),
        entryId: randomId("entry"),
        previousPath: `Note-${index}.md`,
        deletedSide: "local",
        previousBlobHash: null,
        previousRemoteFileId: null,
        createdAt: new Date(index).toISOString()
      }));
    }

    const snapshots = backend.listAllFiles().filter((path) => path.startsWith("snapshots/") && path.endsWith(".snapshot.json"));
    expect(snapshots).toHaveLength(2);
    expect(backend.listAllFiles().filter((path) => path.startsWith("wal/") && path.endsWith(".wal.json"))).toHaveLength(129);

    const newest = snapshots.at(-1)!;
    backend.tamperText(newest, "{corrupt");
    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("64");
    expect(reopened.summary().tombstones).toBe(64);
    const integrity = await reopened.verifyIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.storage.invalidRecoveryGenerationCount).toBeGreaterThan(0);
    expect(integrity.errors.join(" ")).toMatch(/recovery generation.*failed verification/i);
  });

  it("creates genesis, commits metadata transaction, and survives reopen", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const blob = await store.putTextBlob("base version\n");
    const entryId = randomId("entry");

    await store.transact("test-put-file", (tx) => {
      tx.putFile({
        entryId,
        path: "Notes/Test.md",
        baseline: { blobHash: blob.hash, size: blob.size, createdAt: new Date().toISOString(), path: "Notes/Test.md", remoteFileId: null, remoteEtag: null },
        local: { path: "Notes/Test.md", contentHash: blob.hash, size: blob.size, mtimeMs: 1000 },
        remote: null,
        status: "local-dirty"
      });
    });

    expect(store.summary().generation).toBe("1");
    expect(store.summary().walSequence).toBe("3");
    expect(store.getState().pathIndex["Notes/Test.md"]).toBe(entryId);

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.getState().files[entryId]?.baseline?.blobHash).toBe(blob.hash);
    expect((await reopened.verifyIntegrity()).ok).toBe(true);
  });

  it("aborts an incomplete transaction discovered during crash recovery", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const state = store.getState();

    const journal = new WalJournal(backend);
    journal.initialize(state.storeId, state.lastWalSequence, state.lastWalHash);
    await journal.append({
      kind: "transaction-begin",
      transactionId: randomId("tx"),
      baseGeneration: state.generation,
      reason: "simulated-crash"
    });

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("0");
    expect(reopened.summary().walSequence).toBe("3");
    expect((await reopened.verifyIntegrity()).ok).toBe(true);
  });

  it("falls back from a corrupt latest snapshot and replays the WAL", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("put-tombstone", (tx) => {
      tx.putTombstone({
        tombstoneId: randomId("tomb"),
        entryId: randomId("entry"),
        previousPath: "Old.md",
        deletedSide: "local",
        previousBlobHash: null,
        previousRemoteFileId: null,
        createdAt: new Date().toISOString()
      });
    });

    const snapshots = backend.listAllFiles().filter((path) => path.startsWith("snapshots/") && path.endsWith(".snapshot.json"));
    const newest = snapshots.at(-1);
    expect(newest).toBeTruthy();
    backend.tamperText(newest!, "{corrupt");

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
  });

  it("fails closed when the WAL anchor itself is corrupted", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("put-tombstone", (tx) => {
      tx.putTombstone({
        tombstoneId: randomId("tomb"),
        entryId: randomId("entry"),
        previousPath: "Old.md",
        deletedSide: "remote",
        previousBlobHash: null,
        previousRemoteFileId: "123",
        createdAt: new Date().toISOString()
      });
    });

    const wal = backend.listAllFiles().filter((path) => path.startsWith("wal/") && path.endsWith(".wal.json"));
    backend.tamperText(wal.at(-1)!, "{}");
    await expect(DurableStateStore.open(backend, logger)).rejects.toThrow();
  });

  it("detects corrupt immutable baseline objects", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const blob = await store.putTextBlob("important baseline");
    const entryId = randomId("entry");
    await store.transact("baseline-reference", (tx) => {
      tx.putFile({
        entryId,
        path: "Important.md",
        baseline: { blobHash: blob.hash, size: blob.size, createdAt: new Date().toISOString(), path: "Important.md", remoteFileId: null, remoteEtag: null },
        local: { path: "Important.md", contentHash: blob.hash, size: blob.size, mtimeMs: 1 },
        remote: null,
        status: "clean"
      });
    });

    const objectPath = backend.listAllFiles().find((path) => path.endsWith(`${blob.hash}.blob`));
    expect(objectPath).toBeTruthy();
    backend.tamperBinary(objectPath!, new Uint8Array([1, 2, 3]));

    const report = await store.verifyIntegrity();
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/Missing, corrupt, or size-mismatched immutable object/);
  });

  it("rejects path collisions before writing a WAL intent", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const hash = (await store.putTextBlob("x")).hash;
    const size = 1;
    const a = randomId("entry");
    const b = randomId("entry");

    await store.transact("first", (tx) => {
      tx.putFile({
        entryId: a,
        path: "Same.md",
        baseline: { blobHash: hash, size, createdAt: new Date().toISOString(), path: "Same.md", remoteFileId: null, remoteEtag: null },
        local: { path: "Same.md", contentHash: hash, size, mtimeMs: 1 },
        remote: null,
        status: "clean"
      });
    });
    const before = store.summary();

    await expect(
      store.transact("collision", (tx) => {
        tx.putFile({
          entryId: b,
          path: "Same.md",
          baseline: { blobHash: hash, size, createdAt: new Date().toISOString(), path: "Same.md", remoteFileId: null, remoteEtag: null },
          local: { path: "Same.md", contentHash: hash, size, mtimeMs: 2 },
          remote: null,
          status: "clean"
        });
      })
    ).rejects.toThrow(/Duplicate local path/);

    expect(store.summary().generation).toBe(before.generation);
    expect(store.summary().walSequence).toBe(before.walSequence);
  });
  it("rebuilds entirely from WAL when no valid snapshot remains", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("wal-only-recovery", (tx) => {
      tx.putTombstone({
        tombstoneId: randomId("tomb"),
        entryId: randomId("entry"),
        previousPath: "Recovered.md",
        deletedSide: "both",
        previousBlobHash: null,
        previousRemoteFileId: null,
        createdAt: new Date().toISOString()
      });
    });

    for (const path of backend.listAllFiles().filter((item) => item.startsWith("snapshots/") && item.endsWith(".snapshot.json"))) {
      backend.tamperText(path, "{broken");
    }

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
    const integrity = await reopened.verifyIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.storage.invalidRecoveryGenerationCount).toBeGreaterThan(0);
  });

  it("replays valid WAL entries after an older durable snapshot", async () => {
    const backend = new MemoryStateBackend();
    let store = await DurableStateStore.open(backend, logger);
    const putTombstone = async (path: string): Promise<void> => {
      await store.transact("snapshot-plus-wal", (tx) => tx.putTombstone({
        tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: path, deletedSide: "local",
        previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
      }));
    };
    await putTombstone("BeforeSnapshot.md");
    await store.close();
    store = await DurableStateStore.open(backend, logger);
    await putTombstone("AfterSnapshot.md");

    store = await DurableStateStore.open(backend, logger);
    expect(store.summary().generation).toBe("2");
    expect(store.summary().tombstones).toBe(2);
    expect((await store.verifyIntegrity()).ok).toBe(true);
  });

  it("fails closed when a verified checkpoint is followed by a corrupt WAL tail", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("snapshot-wal-tail", (tx) => tx.putTombstone({
      tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: "Keep.md", deletedSide: "remote",
      previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
    }));
    const wal = backend.listAllFiles().filter((path) => path.startsWith("wal/") && path.endsWith(".wal.json"));
    backend.tamperText(wal.at(-1)!, "{truncated-tail");
    await expect(DurableStateStore.open(backend, logger)).rejects.toThrow();
  });

  it("recovers from a standalone generation when the historical WAL prefix is absent", async () => {
    const backend = new MemoryStateBackend();
    let store = await DurableStateStore.open(backend, logger);
    const add = async (name: string): Promise<void> => store.transact("generation-tail", (tx) => tx.putTombstone({
      tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: name, deletedSide: "local",
      previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
    })).then(() => undefined);
    await add("Checkpoint.md");
    await store.close();
    const firstWal = backend.listAllFiles().find((path) => /^wal\/000000000000000000000001-.*\.wal\.json$/.test(path));
    expect(firstWal).toBeTruthy();
    await backend.remove(firstWal!);

    store = await DurableStateStore.open(backend, logger);
    expect(store.summary().generation).toBe("1");
    const checkpointIntegrity = await store.verifyIntegrity();
    expect(checkpointIntegrity.ok).toBe(true);
    expect(checkpointIntegrity.source).toBe("recovery-generation");
    await add("AfterCheckpoint.md");
    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("2");
    expect(reopened.summary().tombstones).toBe(2);
    const tailIntegrity = await reopened.verifyIntegrity();
    expect(tailIntegrity.ok).toBe(true);
    expect(tailIntegrity.source).toBe("recovery-generation");
  });

  it("falls back to an older verified recovery generation and replays its full WAL tail", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("generation-fallback", (tx) => tx.putTombstone({
      tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: "Fallback.md", deletedSide: "remote",
      previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
    }));
    await store.close();

    const generationFiles = backend.listAllFiles().filter((path) => path.startsWith("generations/") && path.endsWith(".generation.json"));
    expect(generationFiles.length).toBeGreaterThanOrEqual(2);
    const newestGeneration = generationFiles.at(-1)!;
    const envelope = JSON.parse(await backend.readText(newestGeneration)) as { snapshotFileName: string };
    backend.tamperText(`snapshots/${envelope.snapshotFileName}`, "{corrupt-checkpoint");

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
    expect(reopened.summary().status).toBe("ready");
  });

  it("keeps the previous generation and WAL authoritative when a new manifest is not published", async () => {
    const backend = new GenerationPublicationFailureBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("interrupted-generation-publication", (tx) => tx.putTombstone({
      tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: "StillRecoverable.md", deletedSide: "local",
      previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
    }));

    backend.failNextGenerationRename = true;
    await store.close();
    expect(backend.listAllFiles().filter((path) => path.startsWith("generations/") && path.endsWith(".generation.json"))).toHaveLength(1);

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
    expect(reopened.summary().status).toBe("ready");
  });

  it("recovers the previous generation when a candidate manifest write is interrupted midway", async () => {
    const backend = new GenerationPublicationFailureBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("interrupted-generation-write", (tx) => tx.putTombstone({
      tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: "InterruptedWrite.md", deletedSide: "remote",
      previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
    }));

    backend.failDuringGenerationWrite = true;
    await store.close();
    expect(backend.listAllFiles().filter((path) => path.startsWith("generations/") && path.endsWith(".generation.json"))).toHaveLength(1);

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
    expect(reopened.summary().status).toBe("ready");
  });

  it("accepts an exact generation when the adapter reports failure after its final rename", async () => {
    const backend = new GenerationPublicationFailureBackend();
    const store = await DurableStateStore.open(backend, logger);
    await store.transact("ambiguous-generation-publication", (tx) => tx.putTombstone({
      tombstoneId: randomId("tomb"), entryId: randomId("entry"), previousPath: "Published.md", deletedSide: "local",
      previousBlobHash: null, previousRemoteFileId: null, createdAt: new Date().toISOString()
    }));

    backend.failAfterGenerationRename = true;
    await store.close();
    const generationFiles = backend.listAllFiles().filter((path) => path.startsWith("generations/") && path.endsWith(".generation.json"));
    expect(generationFiles).toHaveLength(2);

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
    expect(reopened.summary().status).toBe("ready");
  });

  it("refuses to commit metadata that references a missing baseline object", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const before = store.summary();
    const missing = "a".repeat(64);

    await expect(
      store.transact("missing-baseline", (tx) => {
        tx.putFile({
          entryId: randomId("entry"),
          path: "Missing.md",
          baseline: { blobHash: missing, size: 5, createdAt: new Date().toISOString(), path: "Missing.md", remoteFileId: null, remoteEtag: null },
          local: null,
          remote: null,
          status: "clean"
        });
      })
    ).rejects.toThrow(/missing, corrupt, or size-mismatched immutable object/i);

    expect(store.summary().generation).toBe(before.generation);
    expect(store.summary().walSequence).toBe(before.walSequence);
  });

  it("fails closed on an unresolved WAL write ambiguity and recovers deterministically on reopen", async () => {
    const backend = new AmbiguousCommitBackend();
    const store = await DurableStateStore.open(backend, logger);

    await expect(
      store.transact("ambiguous-commit", (tx) => {
        tx.putTombstone({
          tombstoneId: randomId("tomb"),
          entryId: randomId("entry"),
          previousPath: "Ambiguous.md",
          deletedSide: "local",
          previousBlobHash: null,
          previousRemoteFileId: null,
          createdAt: new Date().toISOString()
        });
      })
    ).rejects.toThrow(/simulated adapter error/);

    expect(store.summary().status).toBe("degraded");
    await expect(store.transact("must-not-run", () => undefined)).rejects.toThrow(/degraded/i);

    const reopened = await DurableStateStore.open(backend, logger);
    expect(reopened.summary().status).toBe("ready");
    expect(reopened.summary().generation).toBe("1");
    expect(reopened.summary().tombstones).toBe(1);
    expect((await reopened.verifyIntegrity()).ok).toBe(true);
    const recoveredAgain = await DurableStateStore.open(backend, logger);
    expect(recoveredAgain.summary().generation).toBe(reopened.summary().generation);
    expect(recoveredAgain.summary().walSequence).toBe(reopened.summary().walSequence);
    expect((await recoveredAgain.verifyIntegrity()).ok).toBe(true);
  });

  it("rejects a baseline reference whose declared size does not match the immutable object", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const blob = await store.putTextBlob("abc");
    const before = store.summary();

    await expect(
      store.transact("wrong-baseline-size", (tx) => {
        tx.putFile({
          entryId: randomId("entry"),
          path: "WrongSize.md",
          baseline: { blobHash: blob.hash, size: blob.size + 1, createdAt: new Date().toISOString(), path: "WrongSize.md", remoteFileId: null, remoteEtag: null },
          local: null,
          remote: null,
          status: "clean"
        });
      })
    ).rejects.toThrow(/size-mismatched/i);

    expect(store.summary().walSequence).toBe(before.walSequence);
  });

  it("includes every replayable historical BASE reference in read-only storage reachability", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const entryId = randomId("entry");
    const original = await store.putTextBlob("original BASE");
    await store.transact("baseline-original", (tx) => tx.putFile({
      entryId,
      path: "History.md",
      baseline: { blobHash: original.hash, size: original.size, createdAt: new Date(1).toISOString(), path: "History.md", remoteFileId: null, remoteEtag: null },
      local: { path: "History.md", contentHash: original.hash, size: original.size, mtimeMs: 1 },
      remote: null,
      status: "local-dirty"
    }));

    const replacement = await store.putTextBlob("replacement BASE");
    await store.transact("baseline-replacement", (tx) => tx.putFile({
      entryId,
      path: "History.md",
      baseline: { blobHash: replacement.hash, size: replacement.size, createdAt: new Date(2).toISOString(), path: "History.md", remoteFileId: null, remoteEtag: null },
      local: { path: "History.md", contentHash: replacement.hash, size: replacement.size, mtimeMs: 2 },
      remote: null,
      status: "local-dirty"
    }));

    const report = await store.verifyIntegrity();

    expect(report.ok).toBe(true);
    expect(report.storage.referencedObjectCount).toBe(2);
    expect(report.storage.presentReferencedObjectNames).toBe(2);
    expect(report.storage.unreferencedObjectNames).toBe(0);
    expect(report.storage.garbageCollectionEnabled).toBe(false);
    expect(report.storage.estimatedReclaimableBytes).toBeNull();
    expect(report.storage.walRecordCount).toBe(5);
    expect(report.storage.walTransactionCount).toBe(2);
    expect(report.storage.walBytes).toBeGreaterThan(0);
  });

  it("reports unreferenced objects and suspicious entries without deleting evidence", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const orphan = await store.putTextBlob("not yet referenced");
    await backend.writeBinary("objects/ab/not-a-hash.blob", new Uint8Array([1]).buffer);
    await backend.writeBinary(`objects/.staging/blob_${"f".repeat(32)}.tmp`, new Uint8Array([2]).buffer);
    await backend.writeText("objects/.staging/keep.marker", "evidence");

    const report = await store.verifyIntegrity();

    expect(report.ok).toBe(true);
    expect(report.storage.unreferencedObjectNames).toBe(1);
    expect(report.storage.unreferencedObjectBytes).toBe(orphan.size);
    expect(report.storage.malformedObjectNameCount).toBe(1);
    expect(report.storage.stagingFileCount).toBe(1);
    expect(report.storage.unknownObjectEntryCount).toBe(1);
    expect(await backend.exists(`objects/${orphan.hash.slice(0, 2)}/${orphan.hash}.blob`)).toBe(true);
    expect(await backend.exists("objects/ab/not-a-hash.blob")).toBe(true);
    expect(await backend.exists(`objects/.staging/blob_${"f".repeat(32)}.tmp`)).toBe(true);
    expect(await backend.exists("objects/.staging/keep.marker")).toBe(true);
  });

  it("measures object sizes with a bounded 16-request inventory batch", async () => {
    const backend = new MeasuringInventoryBackend();
    for (let index = 0; index < 32; index += 1) {
      const hash = `${"a".repeat(62)}${index.toString(16).padStart(2, "0")}`;
      await backend.writeBinary(`objects/aa/${hash}.blob`, new Uint8Array([index]).buffer);
    }

    const inventory = await new ObjectStore(backend).inspect(new Set());

    expect(inventory.validObjectNames).toBe(32);
    expect(inventory.unreferencedObjectNames).toBe(32);
    expect(backend.statCalls).toBe(32);
    expect(backend.maxConcurrentStats).toBe(16);
  });

  it("treats prototype-looking vault paths as ordinary path-index keys", async () => {
    const backend = new MemoryStateBackend();
    const store = await DurableStateStore.open(backend, logger);
    const entryId = randomId("entry");

    await store.transact("prototype-looking-path", (tx) => {
      tx.putFile({
        entryId,
        path: "__proto__",
        baseline: null,
        local: { path: "__proto__", contentHash: "b".repeat(64), size: 0, mtimeMs: 1 },
        remote: null,
        status: "local-dirty"
      });
    });

    const state = store.getState();
    expect(Object.hasOwn(state.pathIndex, "__proto__")).toBe(true);
    expect(state.pathIndex["__proto__"]).toBe(entryId);
    expect((await store.verifyIntegrity()).ok).toBe(true);
  });

});
