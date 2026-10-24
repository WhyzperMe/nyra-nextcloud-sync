import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { TransferJournalStore } from "../src/transfer/journal";
import type { TransferJournalPayload } from "../src/transfer/types";
import { makeMemoryVault, MemoryVaultAdapter } from "./helpers/memory-vault";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const PLUGIN_ID = "nyra-nextcloud-sync";
const DEVICE_SCOPE = "c".repeat(32);
const OPERATION_KEY = "a".repeat(64);
const JOURNAL_DIR = `.obsidian/plugins/${PLUGIN_ID}/runtime/${DEVICE_SCOPE}/transfer/journal/${OPERATION_KEY}`;

class FailAfterNewestRecordRemovalAdapter extends MemoryVaultAdapter {
  private failed = false;

  override async remove(path: string): Promise<void> {
    if (!this.failed && path.endsWith("/00000003.json")) {
      this.failed = true;
      await super.remove(path);
      throw new Error("simulated interruption after removing newest record");
    }
    await super.remove(path);
  }
}

class ExcessiveOperationListingAdapter extends MemoryVaultAdapter {
  override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (path.endsWith("/transfer/journal")) {
      return {
        files: [],
        folders: Array.from({ length: 10_001 }, (_, index) => `${path}/${index.toString(16).padStart(64, "0")}`)
      };
    }
    return await super.list(path);
  }
}

describe("transfer journal cleanup safety", () => {
  it("preserves temporary and unknown evidence during reads and cleanup", async () => {
    const adapter = new MemoryVaultAdapter();
    const journal = makeJournal(adapter);
    await journal.create(payload());
    const tempPath = `${JOURNAL_DIR}/.00000002.tmp_${"b".repeat(32)}.tmp`;
    const unknownPath = `${JOURNAL_DIR}/operator-notes.txt`;
    await adapter.write(tempPath, "interrupted staging evidence");
    await adapter.write(unknownPath, "keep for review");

    expect((await journal.load(OPERATION_KEY))?.sequence).toBe(1);
    await journal.remove(OPERATION_KEY);

    expect(await adapter.exists(tempPath)).toBe(true);
    expect(await adapter.exists(unknownPath)).toBe(true);
    expect(await adapter.exists(`${JOURNAL_DIR}/00000001.json`)).toBe(true);
  });

  it("does not recursively remove unexpected nested evidence", async () => {
    const adapter = new MemoryVaultAdapter();
    const journal = makeJournal(adapter);
    await journal.create(payload());
    const evidence = `${JOURNAL_DIR}/evidence/private.txt`;
    await adapter.write(evidence, "preserve this file");

    await journal.remove(OPERATION_KEY);

    expect(await adapter.exists(evidence)).toBe(true);
    expect(await adapter.exists(`${JOURNAL_DIR}/00000001.json`)).toBe(true);
  });

  it("keeps a valid sequence prefix when cleanup is interrupted", async () => {
    const adapter = new FailAfterNewestRecordRemovalAdapter();
    const journal = makeJournal(adapter);
    let record = await journal.create(payload());
    record = await journal.append(record, { phase: "upload-created" });
    record = await journal.append(record, { phase: "uploading", uploadedChunks: [0] });

    await expect(journal.remove(OPERATION_KEY)).rejects.toThrow(/simulated interruption/);

    const remaining = await journal.load(OPERATION_KEY);
    expect(remaining?.sequence).toBe(2);
    expect(await adapter.exists(`${JOURNAL_DIR}/00000001.json`)).toBe(true);
    expect(await adapter.exists(`${JOURNAL_DIR}/00000002.json`)).toBe(true);
    expect(await adapter.exists(`${JOURNAL_DIR}/00000003.json`)).toBe(false);
  });

  it("verifies the complete record chain before deleting any journal history", async () => {
    const adapter = new MemoryVaultAdapter();
    const journal = makeJournal(adapter);
    const second = await journal.append(await journal.create(payload()), { phase: "upload-created" });
    const secondPath = `${JOURNAL_DIR}/00000002.json`;
    await adapter.write(secondPath, "corrupt record");

    await expect(journal.remove(OPERATION_KEY)).rejects.toThrow();

    expect(await adapter.exists(`${JOURNAL_DIR}/00000001.json`)).toBe(true);
    expect(await adapter.exists(secondPath)).toBe(true);
    expect(second.sequence).toBe(2);
  });

  it("removes a verified journal using exact record names and a non-recursive directory removal", async () => {
    const adapter = new MemoryVaultAdapter();
    const journal = makeJournal(adapter);
    const record = await journal.append(await journal.create(payload()), { phase: "upload-created" });

    await journal.remove(OPERATION_KEY);

    expect(await adapter.exists(`${JOURNAL_DIR}/00000001.json`)).toBe(false);
    expect(await adapter.exists(`${JOURNAL_DIR}/00000002.json`)).toBe(false);
    expect(await adapter.exists(JOURNAL_DIR)).toBe(false);
    expect(record.sequence).toBe(2);
  });

  it("fails closed when the transfer journal inventory exceeds its operation bound", async () => {
    const journal = makeJournal(new ExcessiveOperationListingAdapter());

    await expect(journal.listLatest()).rejects.toThrow(/10000-operation safety limit/);
  });
});

function makeJournal(adapter: MemoryVaultAdapter): TransferJournalStore {
  return new TransferJournalStore(makeMemoryVault(adapter), PLUGIN_ID, logger, DEVICE_SCOPE);
}

function payload(): TransferJournalPayload {
  const timestamp = "2026-09-28T10:00:00.000Z";
  return {
    version: 1,
    operationKey: OPERATION_KEY,
    operationId: "1".repeat(24),
    kind: "chunked-create",
    phase: "prepared",
    targetPath: "Notes/Remote.md",
    targetUrl: "https://cloud.example.test/remote.php/dav/files/user/Notes/Remote.md",
    tempPath: ".nyra-tmp/create.bin",
    tempUrl: "https://cloud.example.test/remote.php/dav/files/user/.nyra-tmp/create.bin",
    backupPath: null,
    backupUrl: null,
    uploadId: `nyra-${"2".repeat(24)}`,
    uploadUrl: "https://cloud.example.test/remote.php/dav/uploads/user/session/",
    sourceHash: "3".repeat(64),
    sourceSize: 3,
    chunkSize: 3,
    chunkCount: 1,
    uploadedChunks: [],
    expectedTargetFileId: null,
    expectedTargetEtag: null,
    tempFileId: null,
    tempEtag: null,
    backupFileId: null,
    backupEtag: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
