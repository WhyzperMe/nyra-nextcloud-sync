import type { Logger } from "../../diagnostics/logger";
import type { StateBackend } from "./backend";
import { canonicalStringify } from "./canonical-json";
import { incrementCounter, randomId } from "./ids";
import { AsyncMutex } from "./mutex";
import {
  type DurableMutation,
  type DurableState,
  type FileReplicaInput,
  type FileReplicaRecord,
  type TombstoneInput,
  type TombstoneRecord,
  createEmptyState
} from "./model";
import { ObjectStore, type StoredBlob } from "./object-store";
import { RecoveryGenerationRepository } from "./generations";
import { canonicalVaultRelativePath } from "./path";
import {
  recoverExistingState,
  recoverFromGenerationCheckpoint,
  rebuildEntirelyFromWal,
  type PendingTransaction
} from "./recovery";
import { SnapshotRepository } from "./snapshots";
import { assertStateInvariants } from "./validation";
import { validateReason, WalJournal } from "./wal";
import { applyMutations } from "./mutations";
import { collectStateBlobReferences, collectWalBlobReferences } from "./reachability";

const CHECKPOINT_EVERY_TRANSACTIONS = 32;

export interface DurableStateSummary {
  storeId: string;
  generation: string;
  walSequence: string;
  files: number;
  tombstones: number;
  status: "ready" | "degraded" | "closed";
}

export interface DurableStateStoreOptions {
  /** Obsidian's DataAdapter.readBinary materializes a complete ArrayBuffer. */
  maxBaselineObjectReadBytes?: number;
}

export interface IntegrityReport {
  ok: boolean;
  source: "wal-rebuild" | "recovery-generation";
  generation: string;
  walSequence: string;
  fileRecords: number;
  tombstones: number;
  verifiedBaselineObjects: number;
  validSnapshotCount: number;
  latestSnapshotSequence: string | null;
  snapshotInvalidCount: number;
  storage: DurableStorageHealth;
  errors: string[];
}

export interface DurableStorageHealth {
  auditCompletedAt: string;
  lastSuccessfulAuditAt: string | null;
  walRecordCount: number;
  walTransactionCount: number;
  walBytes: number | null;
  currentSnapshotSequence: string | null;
  previousSnapshotSequence: string | null;
  currentSnapshotAgeMs: number | null;
  validSnapshotCount: number;
  verifiedRecoveryGenerationCount: number;
  invalidRecoveryGenerationCount: number;
  currentRecoverySequence: string | null;
  previousRecoverySequence: string | null;
  referencedObjectCount: number;
  presentReferencedObjectNames: number;
  missingReferencedObjectNames: number;
  unreferencedObjectNames: number;
  unreferencedObjectBytes: number;
  objectCount: number;
  objectBytes: number;
  unknownObjectSizeCount: number;
  malformedObjectNameCount: number;
  unknownObjectEntryCount: number;
  stagingFileCount: number;
  estimatedReclaimableBytes: null;
  garbageCollectionEnabled: false;
  lastSuccessfulGcAt: null;
}

export interface DurableTransaction {
  readonly transactionId: string;
  readonly generation: string;
  putFile(record: FileReplicaInput): void;
  removeFile(entryId: string): void;
  putTombstone(record: TombstoneInput): void;
  removeTombstone(tombstoneId: string): void;
}

class TransactionBuilder implements DurableTransaction {
  readonly mutations: DurableMutation[] = [];

  constructor(
    readonly transactionId: string,
    readonly generation: string
  ) {}

  putFile(record: FileReplicaInput): void {
    const baseline = record.baseline === null ? null : {
      ...structuredClone(record.baseline),
      path: canonicalVaultRelativePath(record.baseline.path)
    };
    const local = record.local === null ? null : {
      ...structuredClone(record.local),
      path: canonicalVaultRelativePath(record.local.path)
    };
    const remote = record.remote === null ? null : {
      ...structuredClone(record.remote),
      path: canonicalVaultRelativePath(record.remote.path)
    };
    const path = canonicalVaultRelativePath(local?.path ?? remote?.path ?? baseline?.path ?? record.path);
    const full: FileReplicaRecord = {
      entryId: record.entryId,
      path,
      generation: this.generation,
      baseline,
      local,
      remote,
      status: record.status
    };
    this.mutations.push({ kind: "put-file", record: full });
  }

  removeFile(entryId: string): void {
    this.mutations.push({ kind: "remove-file", entryId });
  }

  putTombstone(record: TombstoneInput): void {
    const full: TombstoneRecord = {
      tombstoneId: record.tombstoneId,
      entryId: record.entryId,
      previousPath: canonicalVaultRelativePath(record.previousPath),
      generation: this.generation,
      deletedSide: record.deletedSide,
      previousBlobHash: record.previousBlobHash,
      previousRemoteFileId: record.previousRemoteFileId,
      createdAt: record.createdAt
    };
    this.mutations.push({ kind: "put-tombstone", record: full });
  }

  removeTombstone(tombstoneId: string): void {
    this.mutations.push({ kind: "remove-tombstone", tombstoneId });
  }
}

export class DurableStateStore {
  private readonly mutex = new AsyncMutex();
  private readonly journal: WalJournal;
  private readonly snapshots: SnapshotRepository;
  private readonly generations: RecoveryGenerationRepository;
  private readonly objects: ObjectStore;
  private state: DurableState;
  private writable = true;
  private closed = false;
  private commitsSinceCheckpoint = 0;
  private lastSuccessfulAuditAt: string | null = null;

  private constructor(
    private readonly logger: Logger,
    state: DurableState,
    journal: WalJournal,
    snapshots: SnapshotRepository,
    generations: RecoveryGenerationRepository,
    objects: ObjectStore
  ) {
    this.state = state;
    this.journal = journal;
    this.snapshots = snapshots;
    this.generations = generations;
    this.objects = objects;
  }

  static async open(
    backend: StateBackend,
    logger: Logger,
    options: DurableStateStoreOptions = {}
  ): Promise<DurableStateStore> {
    await backend.mkdirp("");
    const journal = new WalJournal(backend);
    const snapshots = new SnapshotRepository(backend);
    const objects = new ObjectStore(backend, options.maxBaselineObjectReadBytes);
    const generations = new RecoveryGenerationRepository(backend, snapshots, objects);
    await Promise.all([journal.ensureDirectory(), snapshots.ensureDirectory(), generations.ensureDirectory(), objects.ensureDirectory()]);
    try {
      const staging = await objects.cleanupAbandonedStaging();
      if (staging.removed > 0) logger.info("state.abandoned-object-staging-cleaned", staging);
      if (staging.remaining > 0) logger.warn("state.abandoned-object-staging-remains", staging);
    } catch (error) {
      logger.warn("state.object-staging-cleanup-failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const recovered = await recoverExistingState(snapshots, journal, logger, generations, objects);
    let state: DurableState;
    let pending: PendingTransaction[] = [];

    if (!recovered) {
      const now = new Date().toISOString();
      state = createEmptyState(randomId("store"), now);
      journal.initialize(state.storeId, "0", null);
      const genesis = await journal.append({ kind: "store-created", createdAt: now });
      state.lastWalSequence = genesis.sequence;
      state.lastWalHash = genesis.recordHash;
      state.updatedAt = genesis.writtenAt;
      logger.info("state.created", { storeId: state.storeId });
    } else {
      state = recovered.state;
      pending = recovered.pendingTransactions;
      journal.initialize(state.storeId, state.lastWalSequence, state.lastWalHash);
      logger.info("state.recovered", {
        source: recovered.source,
        generation: state.generation,
        replayedRecords: recovered.replayedRecords,
        pendingTransactions: pending.length,
        invalidSnapshots: recovered.snapshotWarnings.length
      });
    }

    const store = new DurableStateStore(logger, state, journal, snapshots, generations, objects);
    if (pending.length > 0) {
      await store.abortRecoveredTransactions(pending);
    } else if (!recovered || recovered.source !== "recovery-generation" || recovered.checkpointRecommended) {
      try {
        await store.saveCheckpoint(state);
      } catch (error) {
        logger.warn("state.recovery-checkpoint-failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return store;
  }

  getState(): DurableState {
    return structuredClone(this.state);
  }

  summary(): DurableStateSummary {
    return {
      storeId: this.state.storeId,
      generation: this.state.generation,
      walSequence: this.state.lastWalSequence,
      files: Object.keys(this.state.files).length,
      tombstones: Object.keys(this.state.tombstones).length,
      status: this.closed ? "closed" : this.writable ? "ready" : "degraded"
    };
  }

  async putBlob(data: ArrayBuffer): Promise<StoredBlob> {
    this.assertOpen();
    return await this.objects.put(data);
  }

  async putBlobChunks(chunks: AsyncIterable<ArrayBuffer>, expectedHash: string, expectedSize: number): Promise<StoredBlob> {
    this.assertOpen();
    return await this.objects.putChunks(chunks, expectedHash, expectedSize);
  }

  async putTextBlob(text: string): Promise<StoredBlob> {
    this.assertOpen();
    return await this.objects.putText(text);
  }

  async getBlob(hash: string): Promise<ArrayBuffer> {
    this.assertOpen();
    return await this.objects.get(hash);
  }

  async getTextBlob(hash: string): Promise<string> {
    this.assertOpen();
    return await this.objects.getText(hash);
  }

  async transact(
    reasonInput: string,
    build: (transaction: DurableTransaction, baseState: Readonly<DurableState>) => void
  ): Promise<DurableState> {
    return await this.mutex.runExclusive(async () => {
      this.assertWritable();
      const reason = validateReason(reasonInput);
      const base = this.state;
      const newGeneration = incrementCounter(base.generation);
      const transactionId = randomId("tx");
      const builder = new TransactionBuilder(transactionId, newGeneration);
      build(builder, structuredClone(base));
      if (builder.mutations.length === 0) return structuredClone(this.state);

      // Validate the resulting state and all immutable references before writing intent.
      const candidate = applyMutations(
        base,
        builder.mutations,
        newGeneration,
        new Date().toISOString()
      );
      await this.verifyMutationBlobReferences(builder.mutations);

      let beginSequence: string | null = null;
      try {
        const begin = await this.journal.append({
          kind: "transaction-begin",
          transactionId,
          baseGeneration: base.generation,
          reason
        });
        beginSequence = begin.sequence;

        const commit = await this.journal.append({
          kind: "transaction-commit",
          transactionId,
          baseGeneration: base.generation,
          newGeneration,
          mutations: structuredClone(builder.mutations)
        });

        // Candidate was validated before WAL I/O; anchor it to the actual commit.
        candidate.lastWalSequence = commit.sequence;
        candidate.lastWalHash = commit.recordHash;
        candidate.updatedAt = commit.writtenAt;
        assertStateInvariants(candidate);
        this.state = candidate;

        this.commitsSinceCheckpoint += 1;
        if (this.commitsSinceCheckpoint >= CHECKPOINT_EVERY_TRANSACTIONS) {
          try {
            await this.saveCheckpoint(this.state);
            this.commitsSinceCheckpoint = 0;
          } catch (error) {
            // WAL commit is the durability boundary. A snapshot is a checkpoint and
            // can be regenerated by replay, so checkpoint failure must not roll back
            // a committed generation. Keep the counter saturated so the next commit
            // retries checkpointing instead of waiting another full interval.
            this.logger.warn("state.checkpoint-failed-after-commit", {
              transactionId,
              generation: newGeneration,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        this.logger.debug("state.transaction-committed", {
          transactionId,
          generation: newGeneration,
          mutations: builder.mutations.length,
          beginSequence,
          commitSequence: commit.sequence
        });
        return structuredClone(this.state);
      } catch (error) {
        // Never guess whether a failed DataAdapter write reached its immutable
        // final name. In particular, do not append an abort after an ambiguous
        // commit write: that could produce COMMIT + ABORT for one transaction.
        // Freeze writes and let startup replay decide from the files that are
        // actually present. A lone BEGIN is then closed by crash-recovery.
        if (this.journal.isWritePoisoned() || beginSequence !== null) {
          this.writable = false;
          this.logger.error("state.transaction-requires-recovery", {
            transactionId,
            beginSequence,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        throw error;
      }
    });
  }

  async verifyIntegrity(): Promise<IntegrityReport> {
    return await this.mutex.runExclusive(async () => {
      this.assertOpen();
      const errors: string[] = [];
      const auditCompletedAt = new Date().toISOString();
      let rebuilt: DurableState | null = null;
      let integritySource: IntegrityReport["source"] = "wal-rebuild";
      let verifiedBaselineObjects = 0;
      let validSnapshotCount = 0;
      let latestSnapshotSequence: string | null = null;
      let snapshotInvalidCount = 0;
      let walRecordCount = 0;
      let walTransactionCount = 0;
      let walBytes: number | null = null;
      let previousSnapshotSequence: string | null = null;
      let currentSnapshotAgeMs: number | null = null;
      let referencedObjectCount = 0;
      let presentReferencedObjectNames = 0;
      let missingReferencedObjectNames = 0;
      let unreferencedObjectNames = 0;
      let unreferencedObjectBytes = 0;
      let objectCount = 0;
      let objectBytes = 0;
      let unknownObjectSizeCount = 0;
      let malformedObjectNameCount = 0;
      let unknownObjectEntryCount = 0;
      let stagingFileCount = 0;
      let verifiedRecoveryGenerationCount = 0;
      let invalidRecoveryGenerationCount = 0;
      let currentRecoverySequence: string | null = null;
      let previousRecoverySequence: string | null = null;

      try {
        const snapshotScan = await this.snapshots.scan();
        const generationScan = await this.generations.scan();
        verifiedRecoveryGenerationCount = generationScan.verified.length;
        invalidRecoveryGenerationCount = generationScan.invalidFiles.length;
        currentRecoverySequence = generationScan.verified.at(-1)?.manifest.walSequence ?? null;
        previousRecoverySequence = [...generationScan.verified].reverse().find((generation) =>
          generation.manifest.walSequence !== currentRecoverySequence
        )?.manifest.walSequence ?? null;
        if (invalidRecoveryGenerationCount > 0) {
          errors.push(`${invalidRecoveryGenerationCount} recovery generation(s) failed verification and remain preserved for review.`);
        }
        snapshotInvalidCount = snapshotScan.invalidFiles.length;
        validSnapshotCount = snapshotScan.validCount;
        latestSnapshotSequence = snapshotScan.newest?.state.lastWalSequence ?? null;
        const priorSnapshot = [...snapshotScan.validFiles].reverse().find((snapshot) => snapshot.walSequence !== latestSnapshotSequence);
        previousSnapshotSequence = priorSnapshot?.walSequence ?? null;
        if (snapshotScan.newest) {
          currentSnapshotAgeMs = Math.max(0, Date.now() - Date.parse(snapshotScan.newest.createdAt));
        }
        const index = await this.journal.index();
        walRecordCount = index.length;
        walBytes = await this.journal.measureBytes(index);
        const reachableHashes = new Set(snapshotScan.objectReferences);
        for (const generation of generationScan.verified) {
          for (const reference of generation.manifest.requiredObjects) reachableHashes.add(reference.hash);
        }
        if (index[0]?.sequence === "1") {
          const replay = await rebuildEntirelyFromWal(index, this.journal, (record) => {
            if (record.event.kind === "transaction-begin") walTransactionCount += 1;
            collectWalBlobReferences(record.event, reachableHashes);
          });
          if (replay.pendingTransactions.length > 0) {
            errors.push(`WAL contains ${replay.pendingTransactions.length} incomplete transaction(s).`);
          }
          rebuilt = replay.state;
        } else {
          let recoveredFromGeneration: Awaited<ReturnType<typeof recoverFromGenerationCheckpoint>> | null = null;
          let selectedCheckpointSequence: string | null = null;
          const failures: string[] = [];
          for (const candidate of [...generationScan.verified].reverse()) {
            const candidateTailRoots = new Set<string>();
            let candidateTailTransactions = 0;
            try {
              recoveredFromGeneration = await recoverFromGenerationCheckpoint(
                candidate.snapshot,
                index,
                this.journal,
                this.objects,
                (record) => {
                  if (record.event.kind === "transaction-begin") candidateTailTransactions += 1;
                  collectWalBlobReferences(record.event, candidateTailRoots);
                }
              );
              selectedCheckpointSequence = candidate.manifest.walSequence;
              walTransactionCount += candidateTailTransactions;
              for (const hash of candidateTailRoots) reachableHashes.add(hash);
              break;
            } catch (error) {
              failures.push(error instanceof Error ? error.message : String(error));
            }
          }
          if (!recoveredFromGeneration || selectedCheckpointSequence === null) {
            throw new Error(`Integrity audit cannot recover from a standalone checkpoint: ${failures.join("; ") || "no verified recovery generation is available"}.`);
          }
          if (recoveredFromGeneration.pendingTransactions.length > 0) {
            errors.push(`WAL tail contains ${recoveredFromGeneration.pendingTransactions.length} incomplete transaction(s).`);
          }
          rebuilt = recoveredFromGeneration.state;
          integritySource = "recovery-generation";
        }
        collectStateBlobReferences(rebuilt, reachableHashes);
        if (canonicalStringify(rebuilt) !== canonicalStringify(this.state)) {
          errors.push(`In-memory state does not match the ${integritySource === "wal-rebuild" ? "full WAL rebuild" : "recovery-generation replay"}.`);
        }

        referencedObjectCount = reachableHashes.size;
        const inventory = await this.objects.inspect(reachableHashes);
        presentReferencedObjectNames = inventory.reachableObjectNames;
        missingReferencedObjectNames = inventory.missingReachableNames;
        unreferencedObjectNames = inventory.unreferencedObjectNames;
        unreferencedObjectBytes = inventory.unreferencedBytes;
        objectCount = inventory.validObjectNames;
        objectBytes = inventory.totalBytes;
        unknownObjectSizeCount = inventory.unknownSizeCount;
        malformedObjectNameCount = inventory.malformedNameCount;
        unknownObjectEntryCount = inventory.unknownEntryCount;
        stagingFileCount = inventory.stagingFileCount;
        if (inventory.missingReachableNames > 0) {
          errors.push(`${inventory.missingReachableNames} object-store reference(s) have no object with the expected SHA-256 name.`);
        }

        const baselineSizes = new Map<string, number>();
        const hashOnly = new Set<string>();
        for (const file of Object.values(rebuilt.files)) {
          if (!file.baseline) continue;
          const existingSize = baselineSizes.get(file.baseline.blobHash);
          if (existingSize !== undefined && existingSize !== file.baseline.size) {
            errors.push(`Immutable object ${file.baseline.blobHash} is referenced with inconsistent baseline sizes.`);
          } else {
            baselineSizes.set(file.baseline.blobHash, file.baseline.size);
          }
        }
        for (const tombstone of Object.values(rebuilt.tombstones)) {
          if (tombstone.previousBlobHash && !baselineSizes.has(tombstone.previousBlobHash)) {
            hashOnly.add(tombstone.previousBlobHash);
          }
        }
        for (const [hash, size] of baselineSizes) {
          if (!(await this.objects.hasVerified(hash, size))) {
            errors.push(`Missing, corrupt, or size-mismatched immutable object ${hash}.`);
          } else {
            verifiedBaselineObjects += 1;
          }
        }
        for (const hash of hashOnly) {
          if (!(await this.objects.hasVerified(hash))) errors.push(`Missing or corrupt immutable object ${hash}.`);
          else verifiedBaselineObjects += 1;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      if (errors.length === 0) this.lastSuccessfulAuditAt = auditCompletedAt;

      return {
        ok: errors.length === 0,
        source: integritySource,
        generation: rebuilt?.generation ?? this.state.generation,
        walSequence: rebuilt?.lastWalSequence ?? this.state.lastWalSequence,
        fileRecords: rebuilt ? Object.keys(rebuilt.files).length : Object.keys(this.state.files).length,
        tombstones: rebuilt ? Object.keys(rebuilt.tombstones).length : Object.keys(this.state.tombstones).length,
        verifiedBaselineObjects,
        validSnapshotCount,
        latestSnapshotSequence,
        snapshotInvalidCount,
        storage: {
          auditCompletedAt,
          lastSuccessfulAuditAt: this.lastSuccessfulAuditAt,
          walRecordCount,
          walTransactionCount,
          walBytes,
          currentSnapshotSequence: latestSnapshotSequence,
          previousSnapshotSequence,
          currentSnapshotAgeMs,
          validSnapshotCount,
          verifiedRecoveryGenerationCount,
          invalidRecoveryGenerationCount,
          currentRecoverySequence,
          previousRecoverySequence,
          referencedObjectCount,
          presentReferencedObjectNames,
          missingReferencedObjectNames,
          unreferencedObjectNames,
          unreferencedObjectBytes,
          objectCount,
          objectBytes,
          unknownObjectSizeCount,
          malformedObjectNameCount,
          unknownObjectEntryCount,
          stagingFileCount,
          estimatedReclaimableBytes: null,
          garbageCollectionEnabled: false,
          lastSuccessfulGcAt: null
        },
        errors
      };
    });
  }

  async close(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.closed) return;
      try {
        await this.saveCheckpoint(this.state);
      } catch (error) {
        this.logger.warn("state.close-checkpoint-failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.closed = true;
    });
  }

  private async abortRecoveredTransactions(pending: PendingTransaction[]): Promise<void> {
    for (const transaction of pending) {
      const abort = await this.journal.append({
        kind: "transaction-abort",
        transactionId: transaction.transactionId,
        baseGeneration: transaction.baseGeneration,
        reason: "crash-recovery"
      });
      this.state.lastWalSequence = abort.sequence;
      this.state.lastWalHash = abort.recordHash;
      this.state.updatedAt = abort.writtenAt;
      this.logger.warn("state.recovered-incomplete-transaction", {
        transactionId: transaction.transactionId,
        beginSequence: transaction.beginSequence,
        reason: transaction.reason
      });
    }
    assertStateInvariants(this.state);
    try {
      await this.saveCheckpoint(this.state);
    } catch (error) {
      this.logger.warn("state.recovery-abort-checkpoint-failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async verifyMutationBlobReferences(mutations: readonly DurableMutation[]): Promise<void> {
    const sized = new Map<string, number>();
    const hashOnly = new Set<string>();
    for (const mutation of mutations) {
      if (mutation.kind === "put-file" && mutation.record.baseline) {
        const { blobHash, size } = mutation.record.baseline;
        const previous = sized.get(blobHash);
        if (previous !== undefined && previous !== size) {
          throw new Error(`Durable transaction references immutable object ${blobHash} with inconsistent sizes.`);
        }
        sized.set(blobHash, size);
      }
      if (mutation.kind === "put-tombstone" && mutation.record.previousBlobHash) {
        hashOnly.add(mutation.record.previousBlobHash);
      }
    }
    for (const [hash, size] of sized) {
      if (!(await this.objects.hasVerified(hash, size))) {
        throw new Error(`Durable transaction references missing, corrupt, or size-mismatched immutable object ${hash}.`);
      }
      hashOnly.delete(hash);
    }
    for (const hash of hashOnly) {
      if (!(await this.objects.hasVerified(hash))) {
        throw new Error(`Durable transaction references missing or corrupt immutable object ${hash}.`);
      }
    }
  }

  private async saveCheckpoint(state: DurableState): Promise<void> {
    const existing = await this.generations.scan();
    const newest = existing.verified.at(-1);
    if (
      newest &&
      existing.invalidFiles.length === 0 &&
      newest.manifest.storeId === state.storeId &&
      newest.manifest.stateGeneration === state.generation &&
      newest.manifest.walSequence === state.lastWalSequence &&
      newest.manifest.walHash === state.lastWalHash &&
      canonicalStringify(newest.snapshot.state) === canonicalStringify(state)
    ) {
      return;
    }

    const checkpoint = await this.snapshots.save(state);
    try {
      const generation = await this.generations.publish(checkpoint);
      const removed = await this.generations.pruneOlderVerified(generation.fileName);
      if (removed.generations > 0 || removed.snapshots > 0) {
        this.logger.info("state.old-recovery-artifacts-pruned", {
          generations: removed.generations,
          snapshots: removed.snapshots,
          retainedVerifiedGenerations: 2
        });
      }
    } catch (error) {
      // Recovery artifacts are immutable; a failed publication or cleanup does
      // not invalidate the authoritative WAL transaction or older checkpoint.
      this.logger.warn("state.recovery-generation-maintenance-failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Durable state store is closed.");
  }

  private assertWritable(): void {
    this.assertOpen();
    if (!this.writable) {
      throw new Error("Durable state store is degraded after an incomplete WAL write. Reload the plugin to run recovery.");
    }
  }
}
