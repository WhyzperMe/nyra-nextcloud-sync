import type { StateBackend } from "./backend";
import { canonicalStringify } from "./canonical-json";
import { isSha256Hex, sha256Hex } from "./crypto";
import { compareCounters, padCounter, randomId } from "./ids";
import { writeImmutableText } from "./immutable-write";
import type { DurableState } from "./model";
import { collectStateBlobReferences } from "./reachability";
import { assertStateInvariants, parseDurableState } from "./validation";

export const SNAPSHOT_FORMAT_VERSION = 1 as const;
const SNAPSHOT_DIR = "snapshots";
const SNAPSHOT_SUFFIX = ".snapshot.json";
const SNAPSHOT_FILE = /^(\d{24})-(\d{24})-([A-Za-z0-9_-]+)\.snapshot\.json$/;

interface SnapshotCore {
  formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  snapshotId: string;
  createdAt: string;
  state: DurableState;
}

interface SnapshotEnvelope extends SnapshotCore {
  checksum: string;
}

export interface LoadedSnapshot {
  fileName: string;
  state: DurableState;
  snapshotId: string;
  createdAt: string;
  /** Hash of the exact immutable envelope bytes, used by recovery-generation manifests. */
  contentHash: string;
}

export interface SnapshotScanResult {
  newest: LoadedSnapshot | null;
  validCount: number;
  validFiles: Array<{ fileName: string; walSequence: string; generation: string; createdAt: string }>;
  objectReferences: string[];
  invalidFiles: Array<{ fileName: string; error: string }>;
}

export class SnapshotRepository {
  constructor(private readonly backend: StateBackend) {}

  async ensureDirectory(): Promise<void> {
    await this.backend.mkdirp(SNAPSHOT_DIR);
  }

  async save(state: DurableState): Promise<LoadedSnapshot> {
    assertStateInvariants(state);
    await this.ensureDirectory();
    const core: SnapshotCore = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      snapshotId: randomId("snapshot"),
      createdAt: new Date().toISOString(),
      state: structuredClone(state)
    };
    const checksum = await sha256Hex(canonicalStringify(core));
    const envelope: SnapshotEnvelope = { ...core, checksum };
    const fileName = `${padCounter(state.lastWalSequence)}-${padCounter(state.generation)}-${core.snapshotId}${SNAPSHOT_SUFFIX}`;
    const serialized = canonicalStringify(envelope);
    await writeImmutableText(this.backend, `${SNAPSHOT_DIR}/${fileName}`, serialized);
    return {
      fileName,
      state: structuredClone(state),
      snapshotId: core.snapshotId,
      createdAt: core.createdAt,
      contentHash: await sha256Hex(serialized)
    };
  }

  async scan(): Promise<SnapshotScanResult> {
    await this.ensureDirectory();
    const listing = await this.backend.list(SNAPSHOT_DIR);
    let newest: LoadedSnapshot | null = null;
    let validCount = 0;
    const validFiles: SnapshotScanResult["validFiles"] = [];
    const objectReferences = new Set<string>();
    const invalidFiles: Array<{ fileName: string; error: string }> = [];

    for (const fileName of listing.files) {
      if (fileName.endsWith(".tmp")) continue;
      if (!fileName.endsWith(SNAPSHOT_SUFFIX)) continue;

      let loaded: LoadedSnapshot;
      try {
        loaded = await this.read(fileName);
      } catch (error) {
        invalidFiles.push({ fileName, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      validCount += 1;
      collectStateBlobReferences(loaded.state, objectReferences);
      validFiles.push({
        fileName: loaded.fileName,
        walSequence: loaded.state.lastWalSequence,
        generation: loaded.state.generation,
        createdAt: loaded.createdAt
      });
      if (!newest) {
        newest = loaded;
        continue;
      }

      const position = compareSnapshotPosition(loaded, newest);
      if (position === 0 && canonicalStringify(loaded.state) !== canonicalStringify(newest.state)) {
        throw new Error(
          `Divergent valid snapshots share WAL ${loaded.state.lastWalSequence} and generation ${loaded.state.generation}.`
        );
      }
      if (position > 0 || (position === 0 && loaded.createdAt > newest.createdAt)) newest = loaded;
    }

    validFiles.sort(compareSnapshotFilePosition);
    return { newest, validCount, validFiles, objectReferences: [...objectReferences], invalidFiles };
  }

  /** Removes only verified immutable snapshots not referenced by retained generations. */
  async pruneExceptVerifiedSnapshotFiles(retainedFileNames: ReadonlySet<string>): Promise<number> {
    const scan = await this.scan();
    let removed = 0;
    for (const snapshot of scan.validFiles) {
      if (retainedFileNames.has(snapshot.fileName)) continue;
      await this.backend.remove(`${SNAPSHOT_DIR}/${snapshot.fileName}`);
      removed += 1;
    }
    return removed;
  }

  async read(fileName: string): Promise<LoadedSnapshot> {
    const match = SNAPSHOT_FILE.exec(fileName);
    if (!match || !match[1] || !match[2] || !match[3]) {
      throw new Error(`Invalid snapshot filename: ${fileName}.`);
    }
    const text = await this.backend.readText(`${SNAPSHOT_DIR}/${fileName}`);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Snapshot ${fileName} is not valid JSON: ${String(error)}`);
    }
    const loaded = await parseSnapshot(raw, fileName, await sha256Hex(text));
    if (BigInt(match[1]).toString() !== loaded.state.lastWalSequence ||
        BigInt(match[2]).toString() !== loaded.state.generation ||
        match[3] !== loaded.snapshotId) {
      throw new Error(`Snapshot filename/identity mismatch in ${fileName}.`);
    }
    return loaded;
  }
}

async function parseSnapshot(raw: unknown, fileName: string, contentHash: string): Promise<LoadedSnapshot> {
  if (!isRecord(raw)) throw new Error(`Snapshot ${fileName} must be an object.`);
  if (raw.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(`Snapshot ${fileName} has an unsupported format version.`);
  }
  if (typeof raw.snapshotId !== "string" || !raw.snapshotId) {
    throw new Error(`Snapshot ${fileName} has an invalid snapshotId.`);
  }
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new Error(`Snapshot ${fileName} has an invalid createdAt timestamp.`);
  }
  if (!isSha256Hex(raw.checksum)) throw new Error(`Snapshot ${fileName} has an invalid checksum.`);

  // Verify the immutable bytes before applying any in-memory schema migration.
  // This preserves compatibility with older snapshots whose state shape is
  // normalized by the current parser after checksum verification.
  const rawCore = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    snapshotId: raw.snapshotId,
    createdAt: raw.createdAt,
    state: raw.state
  };
  const expected = await sha256Hex(canonicalStringify(rawCore));
  if (expected !== raw.checksum) throw new Error(`Snapshot ${fileName} checksum mismatch.`);
  const state = parseDurableState(raw.state);

  return { fileName, state, snapshotId: raw.snapshotId, createdAt: raw.createdAt, contentHash };
}

function compareSnapshotPosition(left: LoadedSnapshot, right: LoadedSnapshot): number {
  const wal = compareCounters(left.state.lastWalSequence, right.state.lastWalSequence);
  if (wal !== 0) return wal;
  return compareCounters(left.state.generation, right.state.generation);
}

function compareSnapshotFilePosition(
  left: SnapshotScanResult["validFiles"][number],
  right: SnapshotScanResult["validFiles"][number]
): number {
  const wal = compareCounters(left.walSequence, right.walSequence);
  if (wal !== 0) return wal;
  const generation = compareCounters(left.generation, right.generation);
  if (generation !== 0) return generation;
  return left.createdAt.localeCompare(right.createdAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
