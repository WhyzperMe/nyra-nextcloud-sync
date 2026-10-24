import type { Logger } from "../../diagnostics/logger";
import { incrementCounter } from "./ids";
import { applyMutations } from "./mutations";
import { createEmptyState, type DurableState } from "./model";
import { collectRequiredObjectReferences, type RecoveryGenerationRepository } from "./generations";
import type { ObjectStore } from "./object-store";
import type { LoadedSnapshot, SnapshotRepository } from "./snapshots";
import {
  type WalFileIndexEntry,
  type WalJournal,
  type WalRecord,
  validateWalChainRecord
} from "./wal";
import { assertStateInvariants } from "./validation";

export interface PendingTransaction {
  transactionId: string;
  baseGeneration: string;
  reason: string;
  beginSequence: string;
}

export interface RecoveryResult {
  state: DurableState;
  source: "recovery-generation" | "snapshot" | "wal-rebuild";
  replayedRecords: number;
  pendingTransactions: PendingTransaction[];
  snapshotWarnings: Array<{ fileName: string; error: string }>;
  checkpointRecommended: boolean;
}

export async function recoverExistingState(
  snapshots: SnapshotRepository,
  journal: WalJournal,
  logger: Logger,
  generations: RecoveryGenerationRepository,
  objects: ObjectStore
): Promise<RecoveryResult | null> {
  const generationScan = await generations.scan();
  const walIndex = await journal.index();
  let recoveryGenerationsFailed = false;

  if (generationScan.verified.length > 0) {
    const failures: Array<{ fileName: string; error: string }> = [...generationScan.invalidFiles];
    for (let index = generationScan.verified.length - 1; index >= 0; index -= 1) {
      const candidate = generationScan.verified[index];
      if (!candidate) continue;
      try {
        const result = await recoverFromSnapshot(candidate.snapshot, walIndex, journal, true);
        await verifyStateObjects(result.state, objects);
        const selectedNewest = index === generationScan.verified.length - 1;
        return {
          ...result,
          source: "recovery-generation",
          snapshotWarnings: failures,
          checkpointRecommended: !selectedNewest || result.replayedRecords > 0 || result.pendingTransactions.length > 0
        };
      } catch (error) {
        failures.push({
          fileName: candidate.fileName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (walIndex.length === 0 || walIndex[0]?.sequence !== "1") {
      throw new Error(`No recovery generation can be replayed from its checkpoint and WAL tail: ${failures.map((item) => item.error).join("; ")}`);
    }
    logger.warn("state.recovery-generations-unusable-falling-back-to-full-wal", {
      invalidGenerations: failures.length,
      walRecords: walIndex.length
    });
    recoveryGenerationsFailed = true;
  }

  if (recoveryGenerationsFailed) {
    const result = await rebuildEntirelyFromWal(walIndex, journal);
    return {
      ...result,
      source: "wal-rebuild",
      snapshotWarnings: generationScan.invalidFiles,
      checkpointRecommended: true
    };
  }

  const snapshotScan = await snapshots.scan();
  if (walIndex.length > 0 && walIndex[0]?.sequence !== "1") {
    throw new Error("Legacy WAL recovery requires sequence 1; no verified standalone recovery generation is available.");
  }

  if (snapshotScan.newest) {
    try {
      const result = await recoverFromSnapshot(snapshotScan.newest, walIndex, journal, false);
      return {
        ...result,
        source: "snapshot",
        snapshotWarnings: snapshotScan.invalidFiles,
        checkpointRecommended: true
      };
    } catch (error) {
      if (walIndex.length === 0 || walIndex[0]?.sequence !== "1") throw error;
      logger.warn("state.snapshot-recovery-failed-falling-back-to-full-wal", {
        error: error instanceof Error ? error.message : String(error)
      });
      const result = await rebuildEntirelyFromWal(walIndex, journal);
      return {
        ...result,
        source: "wal-rebuild",
        snapshotWarnings: snapshotScan.invalidFiles,
        checkpointRecommended: true
      };
    }
  }

  if (walIndex.length > 0) {
    logger.warn("state.snapshot-unavailable-rebuilding-from-wal", {
      invalidSnapshots: snapshotScan.invalidFiles.length,
      walRecords: walIndex.length
    });
    const result = await rebuildEntirelyFromWal(walIndex, journal);
    return {
      ...result,
      source: "wal-rebuild",
      snapshotWarnings: snapshotScan.invalidFiles,
      checkpointRecommended: true
    };
  }

  if (snapshotScan.invalidFiles.length > 0) {
    throw new Error("Durable state contains snapshots, but none are valid and no WAL is available for recovery.");
  }

  return null;
}

export async function rebuildEntirelyFromWal(
  index: WalFileIndexEntry[],
  journal: WalJournal,
  onRecord?: (record: WalRecord) => void
): Promise<Omit<RecoveryResult, "source" | "snapshotWarnings" | "checkpointRecommended">> {
  if (index.length === 0) throw new Error("Cannot rebuild durable state from an empty WAL.");
  if (index[0]?.sequence !== "1") throw new Error("WAL rebuild requires sequence 1 (store-created).");

  const first = await journal.read(index[0]);
  onRecord?.(first);
  if (first.event.kind !== "store-created") {
    throw new Error("WAL sequence 1 must be store-created.");
  }
  if (first.previousRecordHash !== null) {
    throw new Error("WAL sequence 1 must not reference a previous hash.");
  }

  let state = createEmptyState(first.storeId, first.event.createdAt);
  const pending = new Map<string, PendingTransaction>();
  state = applyRecord(state, first, pending, true);
  let replayedRecords = 1;

  for (let i = 1; i < index.length; i += 1) {
    const entry = index[i];
    if (!entry) continue;
    const record = await journal.read(entry);
    onRecord?.(record);
    validateWalChainRecord(record, state.storeId, state.lastWalSequence, state.lastWalHash);
    state = applyRecord(state, record, pending, false);
    replayedRecords += 1;
  }

  assertStateInvariants(state);
  return {
    state,
    replayedRecords,
    pendingTransactions: [...pending.values()]
  };
}

/** Recover from an independently verified checkpoint plus its complete WAL tail. */
export async function recoverFromGenerationCheckpoint(
  snapshot: LoadedSnapshot,
  index: WalFileIndexEntry[],
  journal: WalJournal,
  objects: ObjectStore,
  onTailRecord?: (record: WalRecord) => void
): Promise<Omit<RecoveryResult, "source" | "snapshotWarnings" | "checkpointRecommended">> {
  const recovered = await recoverFromSnapshot(snapshot, index, journal, true, onTailRecord);
  await verifyStateObjects(recovered.state, objects);
  return recovered;
}

async function recoverFromSnapshot(
  snapshot: LoadedSnapshot,
  index: WalFileIndexEntry[],
  journal: WalJournal,
  independentlyVerified: boolean,
  onTailRecord?: (record: WalRecord) => void
): Promise<Omit<RecoveryResult, "source" | "snapshotWarnings" | "checkpointRecommended">> {
  let state = structuredClone(snapshot.state);
  assertStateInvariants(state);

  if (!independentlyVerified && state.lastWalSequence !== "0") {
    const anchorEntry = index.find((entry) => entry.sequence === state.lastWalSequence);
    if (!anchorEntry) {
      throw new Error(`Snapshot references missing WAL sequence ${state.lastWalSequence}.`);
    }
    const anchor = await journal.read(anchorEntry);
    if (anchor.storeId !== state.storeId || anchor.recordHash !== state.lastWalHash) {
      throw new Error("Snapshot WAL anchor does not match the immutable journal.");
    }
    if (anchor.event.kind === "transaction-begin") {
      throw new Error("A snapshot may not checkpoint an open transaction-begin record.");
    }
  }

  const pending = new Map<string, PendingTransaction>();
  let replayedRecords = 0;
  for (const entry of index) {
    if (BigInt(entry.sequence) <= BigInt(state.lastWalSequence)) continue;
    const record = await journal.read(entry);
    validateWalChainRecord(record, state.storeId, state.lastWalSequence, state.lastWalHash);
    state = applyRecord(state, record, pending, false);
    onTailRecord?.(record);
    replayedRecords += 1;
  }

  assertStateInvariants(state);
  return { state, replayedRecords, pendingTransactions: [...pending.values()] };
}

async function verifyStateObjects(state: DurableState, objects: ObjectStore): Promise<void> {
  for (const reference of collectRequiredObjectReferences(state)) {
    if (!(await objects.hasVerified(reference.hash, reference.size ?? undefined))) {
      throw new Error(`Recovered state requires missing or corrupt BASE object ${reference.hash}.`);
    }
  }
}

function applyRecord(
  base: DurableState,
  record: WalRecord,
  pending: Map<string, PendingTransaction>,
  allowStoreCreated: boolean
): DurableState {
  let next = structuredClone(base);

  switch (record.event.kind) {
    case "store-created": {
      if (!allowStoreCreated || record.sequence !== "1" || base.lastWalSequence !== "0") {
        throw new Error("store-created may appear only as the first WAL record.");
      }
      if (record.storeId !== base.storeId) throw new Error("store-created storeId mismatch.");
      break;
    }
    case "transaction-begin": {
      if (pending.size !== 0) throw new Error("WAL contains overlapping durable-state transactions.");
      if (record.event.baseGeneration !== base.generation) {
        throw new Error(`Transaction ${record.event.transactionId} began from the wrong generation.`);
      }
      pending.set(record.event.transactionId, {
        transactionId: record.event.transactionId,
        baseGeneration: record.event.baseGeneration,
        reason: record.event.reason,
        beginSequence: record.sequence
      });
      break;
    }
    case "transaction-commit": {
      const begun = pending.get(record.event.transactionId);
      if (!begun) throw new Error(`Commit without matching begin for ${record.event.transactionId}.`);
      if (begun.baseGeneration !== record.event.baseGeneration || base.generation !== record.event.baseGeneration) {
        throw new Error(`Transaction ${record.event.transactionId} has a stale base generation.`);
      }
      if (record.event.newGeneration !== incrementCounter(base.generation)) {
        throw new Error(`Transaction ${record.event.transactionId} has an invalid new generation.`);
      }
      if (record.event.mutations.length === 0) {
        throw new Error(`Transaction ${record.event.transactionId} committed no mutations.`);
      }
      next = applyMutations(
        base,
        record.event.mutations,
        record.event.newGeneration,
        record.writtenAt
      );
      pending.delete(record.event.transactionId);
      break;
    }
    case "transaction-abort": {
      const begun = pending.get(record.event.transactionId);
      if (!begun) throw new Error(`Abort without matching begin for ${record.event.transactionId}.`);
      if (begun.baseGeneration !== record.event.baseGeneration || base.generation !== record.event.baseGeneration) {
        throw new Error(`Transaction ${record.event.transactionId} abort generation mismatch.`);
      }
      pending.delete(record.event.transactionId);
      break;
    }
    default: {
      const exhaustive: never = record.event;
      throw new Error(`Unsupported WAL event: ${String(exhaustive)}`);
    }
  }

  next.lastWalSequence = record.sequence;
  next.lastWalHash = record.recordHash;
  next.updatedAt = record.writtenAt;
  assertStateInvariants(next);
  return next;
}
