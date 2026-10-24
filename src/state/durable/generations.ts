import type { StateBackend } from "./backend";
import { canonicalStringify } from "./canonical-json";
import { isSha256Hex, sha256Hex } from "./crypto";
import { assertCounter, compareCounters, padCounter, randomId } from "./ids";
import { writeImmutableText } from "./immutable-write";
import type { DurableState } from "./model";
import type { ObjectStore } from "./object-store";
import type { LoadedSnapshot, SnapshotRepository } from "./snapshots";
import { assertStateId, assertStateInvariants } from "./validation";

const GENERATION_DIR = "generations";
const GENERATION_SUFFIX = ".generation.json";
const GENERATION_FILE = /^(\d{24})-(\d{24})-([A-Za-z0-9_-]+)\.generation\.json$/;
const GENERATION_FORMAT_VERSION = 1 as const;
const MAX_GENERATION_OBJECTS = 250_000;

export interface RecoveryObjectReference {
  hash: string;
  size: number | null;
}

interface RecoveryGenerationCore {
  formatVersion: typeof GENERATION_FORMAT_VERSION;
  generationId: string;
  createdAt: string;
  storeId: string;
  stateGeneration: string;
  walSequence: string;
  walHash: string;
  snapshotFileName: string;
  snapshotContentHash: string;
  requiredObjects: RecoveryObjectReference[];
}

interface RecoveryGenerationEnvelope extends RecoveryGenerationCore {
  checksum: string;
}

export interface VerifiedRecoveryGeneration {
  fileName: string;
  manifest: RecoveryGenerationEnvelope;
  snapshot: LoadedSnapshot;
}

export interface RecoveryGenerationScan {
  verified: VerifiedRecoveryGeneration[];
  invalidFiles: Array<{ fileName: string; error: string }>;
}

/**
 * Publishes immutable, standalone checkpoint generations. A generation is
 * accepted only after its exact snapshot bytes and every referenced BASE
 * object have been read back and verified. The directory is an append-only
 * candidate set; recovery never depends on replacing a mutable head pointer.
 */
export class RecoveryGenerationRepository {
  constructor(
    private readonly backend: StateBackend,
    private readonly snapshots: SnapshotRepository,
    private readonly objects: ObjectStore
  ) {}

  async ensureDirectory(): Promise<void> {
    await this.backend.mkdirp(GENERATION_DIR);
  }

  async publish(snapshot: LoadedSnapshot): Promise<VerifiedRecoveryGeneration> {
    assertStateInvariants(snapshot.state);
    await this.ensureDirectory();
    await verifyRequiredObjects(this.objects, snapshot.state);

    const generationId = randomId("generation");
    const core: RecoveryGenerationCore = {
      formatVersion: GENERATION_FORMAT_VERSION,
      generationId,
      createdAt: new Date().toISOString(),
      storeId: snapshot.state.storeId,
      stateGeneration: snapshot.state.generation,
      walSequence: snapshot.state.lastWalSequence,
      walHash: requireWalHash(snapshot.state.lastWalHash),
      snapshotFileName: snapshot.fileName,
      snapshotContentHash: snapshot.contentHash,
      requiredObjects: objectManifest(snapshot.state)
    };
    const envelope: RecoveryGenerationEnvelope = {
      ...core,
      checksum: await sha256Hex(canonicalStringify(core))
    };
    const fileName = `${padCounter(core.walSequence)}-${padCounter(core.stateGeneration)}-${generationId}${GENERATION_SUFFIX}`;
    const serialized = canonicalStringify(envelope);

    // Unique immutable publication keeps the previous generation intact if a
    // backend write/rename is interrupted. The exact final bytes are verified.
    await writeImmutableText(this.backend, `${GENERATION_DIR}/${fileName}`, serialized);
    const verified = await this.readVerified(fileName);
    if (canonicalStringify(verified.snapshot.state) !== canonicalStringify(snapshot.state)) {
      throw new Error("Published recovery generation does not reproduce its checkpoint state.");
    }
    return verified;
  }

  async scan(): Promise<RecoveryGenerationScan> {
    await this.ensureDirectory();
    const listing = await this.backend.list(GENERATION_DIR);
    const verified: VerifiedRecoveryGeneration[] = [];
    const invalidFiles: RecoveryGenerationScan["invalidFiles"] = [];

    for (const fileName of listing.files) {
      if (fileName.endsWith(".tmp") || !fileName.endsWith(GENERATION_SUFFIX)) continue;
      try {
        verified.push(await this.readVerified(fileName));
      } catch (error) {
        invalidFiles.push({ fileName, error: error instanceof Error ? error.message : String(error) });
      }
    }

    verified.sort(compareGenerationPosition);
    for (let index = 1; index < verified.length; index += 1) {
      const previous = verified[index - 1];
      const current = verified[index];
      if (!previous || !current || compareGenerationPosition(previous, current) !== 0) continue;
      if (canonicalStringify(previous.snapshot.state) !== canonicalStringify(current.snapshot.state)) {
        throw new Error(
          `Divergent verified recovery generations share WAL ${current.manifest.walSequence} and state generation ${current.manifest.stateGeneration}.`
        );
      }
    }

    return { verified, invalidFiles };
  }

  /**
   * Keep two distinct verified logical positions. Pruning is maintenance only
   * and refuses to run if any generation failed verification.
   */
  async pruneOlderVerified(expectedNewestFileName: string): Promise<{ generations: number; snapshots: number }> {
    const scan = await this.scan();
    if (scan.invalidFiles.length > 0 || scan.verified.length < 2) return { generations: 0, snapshots: 0 };
    const newest = scan.verified.at(-1);
    if (!newest || newest.fileName !== expectedNewestFileName) return { generations: 0, snapshots: 0 };

    const retained: VerifiedRecoveryGeneration[] = [];
    const positions = new Set<string>();
    for (const candidate of [...scan.verified].reverse()) {
      const position = `${candidate.manifest.walSequence}:${candidate.manifest.stateGeneration}`;
      if (positions.has(position)) continue;
      positions.add(position);
      retained.push(candidate);
      if (retained.length === 2) break;
    }
    if (retained.length < 2) return { generations: 0, snapshots: 0 };

    const retainedGenerations = new Set(retained.map((generation) => generation.fileName));
    const retainedSnapshots = new Set(retained.map((generation) => generation.manifest.snapshotFileName));
    let removedGenerations = 0;
    for (const generation of scan.verified) {
      if (retainedGenerations.has(generation.fileName)) continue;
      await this.backend.remove(`${GENERATION_DIR}/${generation.fileName}`);
      removedGenerations += 1;
    }
    const removedSnapshots = await this.snapshots.pruneExceptVerifiedSnapshotFiles(retainedSnapshots);
    return { generations: removedGenerations, snapshots: removedSnapshots };
  }

  private async readVerified(fileName: string): Promise<VerifiedRecoveryGeneration> {
    const match = GENERATION_FILE.exec(fileName);
    if (!match || !match[1] || !match[2] || !match[3]) {
      throw new Error(`Invalid recovery-generation filename: ${fileName}.`);
    }
    const rawText = await this.backend.readText(`${GENERATION_DIR}/${fileName}`);
    let raw: unknown;
    try {
      raw = JSON.parse(rawText) as unknown;
    } catch (error) {
      throw new Error(`Recovery generation ${fileName} is not valid JSON: ${String(error)}`);
    }
    const manifest = await parseGenerationEnvelope(raw);
    if (
      BigInt(match[1]).toString() !== manifest.walSequence ||
      BigInt(match[2]).toString() !== manifest.stateGeneration ||
      match[3] !== manifest.generationId
    ) {
      throw new Error(`Recovery-generation filename/identity mismatch in ${fileName}.`);
    }

    const snapshot = await this.snapshots.read(manifest.snapshotFileName);
    if (snapshot.contentHash !== manifest.snapshotContentHash) {
      throw new Error(`Recovery generation ${fileName} references different checkpoint bytes.`);
    }
    const state = snapshot.state;
    if (
      state.storeId !== manifest.storeId ||
      state.generation !== manifest.stateGeneration ||
      state.lastWalSequence !== manifest.walSequence ||
      state.lastWalHash !== manifest.walHash
    ) {
      throw new Error(`Recovery generation ${fileName} does not match its checkpoint anchor.`);
    }
    if (canonicalStringify(objectManifest(state)) !== canonicalStringify(manifest.requiredObjects)) {
      throw new Error(`Recovery generation ${fileName} has an incomplete or contradictory BASE object manifest.`);
    }
    await verifyRequiredObjects(this.objects, state);
    return { fileName, manifest, snapshot };
  }
}

export function collectRequiredObjectReferences(state: DurableState): RecoveryObjectReference[] {
  return objectManifest(state);
}

async function verifyRequiredObjects(objects: ObjectStore, state: DurableState): Promise<void> {
  for (const object of objectManifest(state)) {
    if (!(await objects.hasVerified(object.hash, object.size ?? undefined))) {
      throw new Error(`Recovery checkpoint requires missing or corrupt BASE object ${object.hash}.`);
    }
  }
}

function objectManifest(state: DurableState): RecoveryObjectReference[] {
  const references = new Map<string, number | null>();
  for (const file of Object.values(state.files)) {
    if (!file.baseline) continue;
    const existing = references.get(file.baseline.blobHash);
    if (existing !== undefined && existing !== null && existing !== file.baseline.size) {
      throw new Error(`BASE object ${file.baseline.blobHash} has contradictory checkpoint sizes.`);
    }
    references.set(file.baseline.blobHash, file.baseline.size);
  }
  for (const tombstone of Object.values(state.tombstones)) {
    if (!tombstone.previousBlobHash) continue;
    if (!references.has(tombstone.previousBlobHash)) references.set(tombstone.previousBlobHash, null);
  }
  if (references.size > MAX_GENERATION_OBJECTS) {
    throw new Error(`Recovery checkpoint exceeds the ${MAX_GENERATION_OBJECTS}-object manifest limit.`);
  }
  return [...references.entries()]
    .map(([hash, size]) => ({ hash, size }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

async function parseGenerationEnvelope(raw: unknown): Promise<RecoveryGenerationEnvelope> {
  if (!isRecord(raw)) throw new Error("Recovery generation must be an object.");
  if (raw.formatVersion !== GENERATION_FORMAT_VERSION) throw new Error("Unsupported recovery-generation format version.");
  const core: RecoveryGenerationCore = {
    formatVersion: GENERATION_FORMAT_VERSION,
    generationId: requiredString(raw.generationId, "generationId"),
    createdAt: requiredTimestamp(raw.createdAt, "createdAt"),
    storeId: requiredString(raw.storeId, "storeId"),
    stateGeneration: requiredCounter(raw.stateGeneration, "stateGeneration"),
    walSequence: requiredCounter(raw.walSequence, "walSequence"),
    walHash: requiredHash(raw.walHash, "walHash"),
    snapshotFileName: requiredString(raw.snapshotFileName, "snapshotFileName"),
    snapshotContentHash: requiredHash(raw.snapshotContentHash, "snapshotContentHash"),
    requiredObjects: parseObjectManifest(raw.requiredObjects)
  };
  assertStateId(core.generationId, "recovery generationId");
  assertStateId(core.storeId, "recovery storeId");
  if (core.walSequence === "0") throw new Error("A recovery generation must reference a committed WAL record.");
  if (!/^\d{24}-\d{24}-[A-Za-z0-9_-]+\.snapshot\.json$/.test(core.snapshotFileName)) {
    throw new Error("Recovery generation has an invalid snapshot filename.");
  }
  if (!isSha256Hex(raw.checksum)) throw new Error("Recovery generation checksum is invalid.");
  const expectedChecksum = await sha256Hex(canonicalStringify(core));
  if (expectedChecksum !== raw.checksum) throw new Error("Recovery generation checksum mismatch.");
  return { ...core, checksum: raw.checksum };
}

function parseObjectManifest(raw: unknown): RecoveryObjectReference[] {
  if (!Array.isArray(raw) || raw.length > MAX_GENERATION_OBJECTS) {
    throw new Error("Recovery generation object manifest is invalid or exceeds its bound.");
  }
  const output: RecoveryObjectReference[] = [];
  let previousHash = "";
  for (const [index, value] of raw.entries()) {
    if (!isRecord(value) || !isSha256Hex(value.hash)) throw new Error(`Recovery object reference ${index} has an invalid hash.`);
    if (value.hash <= previousHash) throw new Error("Recovery object manifest must be sorted and contain unique hashes.");
    if (value.size !== null && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)) {
      throw new Error(`Recovery object reference ${index} has an invalid size.`);
    }
    output.push({ hash: value.hash, size: value.size as number | null });
    previousHash = value.hash;
  }
  return output;
}

function compareGenerationPosition(left: VerifiedRecoveryGeneration, right: VerifiedRecoveryGeneration): number {
  const wal = compareCounters(left.manifest.walSequence, right.manifest.walSequence);
  if (wal !== 0) return wal;
  const state = compareCounters(left.manifest.stateGeneration, right.manifest.stateGeneration);
  if (state !== 0) return state;
  const time = left.manifest.createdAt.localeCompare(right.manifest.createdAt);
  return time !== 0 ? time : left.manifest.generationId.localeCompare(right.manifest.generationId);
}

function requireWalHash(value: string | null): string {
  if (!isSha256Hex(value)) throw new Error("A recovery generation requires a verified WAL hash anchor.");
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requiredCounter(value: unknown, label: string): string {
  const result = requiredString(value, label);
  assertCounter(result, label);
  return result;
}

function requiredHash(value: unknown, label: string): string {
  if (!isSha256Hex(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value;
}

function requiredTimestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a timestamp.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
