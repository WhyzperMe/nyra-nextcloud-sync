import { describe, expect, it } from "vitest";
import { collectStateBlobReferences, collectWalBlobReferences } from "../src/state/durable/reachability";
import { createEmptyState } from "../src/state/durable/model";

describe("durable object reachability", () => {
  it("collects current BASE and tombstone roots without consulting timestamps", () => {
    const state = createEmptyState();
    state.files.entry = {
      entryId: "entry",
      path: "Note.md",
      generation: "1",
      baseline: {
        blobHash: "a".repeat(64), size: 4, createdAt: "2026-01-01T00:00:00.000Z",
        path: "Note.md", remoteFileId: null, remoteEtag: null
      },
      local: null,
      remote: null,
      status: "conflict"
    };
    state.tombstones.tomb = {
      tombstoneId: "tomb",
      entryId: "entry",
      previousPath: "Note.md",
      generation: "1",
      deletedSide: "local",
      previousBlobHash: "b".repeat(64),
      previousRemoteFileId: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    };

    const roots = new Set<string>();
    collectStateBlobReferences(state, roots);

    expect(roots).toEqual(new Set(["a".repeat(64), "b".repeat(64)]));
  });

  it("retains historical WAL BASE references after current state replaces them", () => {
    const roots = new Set<string>();
    collectWalBlobReferences({
      kind: "transaction-commit",
      transactionId: "tx",
      baseGeneration: "0",
      newGeneration: "1",
      mutations: [
        {
          kind: "put-file",
          record: {
            entryId: "entry", path: "Note.md", generation: "1",
            baseline: {
              blobHash: "c".repeat(64), size: 4, createdAt: "2026-01-01T00:00:00.000Z",
              path: "Note.md", remoteFileId: null, remoteEtag: null
            },
            local: null, remote: null, status: "clean"
          }
        },
        {
          kind: "put-tombstone",
          record: {
            tombstoneId: "tomb", entryId: "entry", previousPath: "Note.md", generation: "1",
            deletedSide: "remote", previousBlobHash: "d".repeat(64), previousRemoteFileId: null,
            createdAt: "2026-01-01T00:00:00.000Z"
          }
        }
      ]
    }, roots);
    collectWalBlobReferences({ kind: "transaction-begin", transactionId: "tx2", baseGeneration: "1", reason: "pending" }, roots);

    expect(roots).toEqual(new Set(["c".repeat(64), "d".repeat(64)]));
  });
});
