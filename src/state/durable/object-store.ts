import type { StateBackend } from "./backend";
import { isSha256Hex, sha256Hex } from "./crypto";
import { writeImmutableBinary } from "./immutable-write";
import { randomId } from "./ids";
import { IncrementalSha256 } from "../../transfer/incremental-sha256";

const OBJECT_DIR = "objects";
const STAGING_DIR = `${OBJECT_DIR}/.staging`;
const MAX_ABANDONED_STAGING_REMOVALS_PER_OPEN = 128;

export interface StoredBlob {
  hash: string;
  size: number;
}

export interface StagingCleanupResult {
  removed: number;
  remaining: number;
}

export interface ObjectStoreInventory {
  validObjectNames: number;
  totalBytes: number;
  unknownSizeCount: number;
  reachableObjectNames: number;
  missingReachableNames: number;
  unreferencedObjectNames: number;
  unreferencedBytes: number;
  malformedNameCount: number;
  unknownEntryCount: number;
  stagingFileCount: number;
}

export class BaselineObjectReadLimitError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`BASE object is ${sizeBytes} bytes; safe whole-buffer verification is limited to ${maxBytes} bytes on this device.`);
    this.name = "BaselineObjectReadLimitError";
  }
}

/** Immutable SHA-256 addressed baseline storage. */
export class ObjectStore {
  constructor(private readonly backend: StateBackend, private readonly maxWholeReadBytes = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maxWholeReadBytes) || maxWholeReadBytes <= 0) {
      throw new Error("BASE object whole-read limit must be a positive safe integer.");
    }
  }

  async ensureDirectory(): Promise<void> {
    await Promise.all([this.backend.mkdirp(OBJECT_DIR), this.backend.mkdirp(STAGING_DIR)]);
  }

  /** Removes only abandoned chunk-staging names at startup, before sync work can begin. */
  async cleanupAbandonedStaging(): Promise<StagingCleanupResult> {
    const listing = await this.backend.list(STAGING_DIR);
    const candidates = listing.files
      .filter((name) => /^blob_[a-f0-9]{32}\.tmp$/i.test(name))
      .sort();
    const selected = candidates.slice(0, MAX_ABANDONED_STAGING_REMOVALS_PER_OPEN);
    let removed = 0;
    for (const name of selected) {
      await this.backend.remove(`${STAGING_DIR}/${name}`);
      removed += 1;
    }
    return { removed, remaining: candidates.length - removed };
  }

  async put(data: ArrayBuffer): Promise<StoredBlob> {
    this.assertWithinWholeReadBudget(data.byteLength);
    const hash = await sha256Hex(data);
    const path = objectPath(hash);
    await writeImmutableBinary(this.backend, path, data);
    return { hash, size: data.byteLength };
  }

  async putChunks(chunks: AsyncIterable<ArrayBuffer>, expectedHash: string, expectedSize: number): Promise<StoredBlob> {
    assertHash(expectedHash);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("Expected object size must be a non-negative safe integer.");
    this.assertWithinWholeReadBudget(expectedSize);
    const finalPath = objectPath(expectedHash);
    if (await this.hasVerified(expectedHash, expectedSize)) return { hash: expectedHash, size: expectedSize };
    if (await this.backend.exists(finalPath)) throw new Error(`Immutable object ${expectedHash} exists but failed verification.`);

    const staging = `${STAGING_DIR}/${randomId("blob")}.tmp`;
    const hasher = new IncrementalSha256();
    let size = 0;
    try {
      await this.backend.writeBinary(staging, new ArrayBuffer(0));
      for await (const chunk of chunks) {
        if (chunk.byteLength === 0) continue;
        size += chunk.byteLength;
        if (!Number.isSafeInteger(size) || size > expectedSize) throw new Error("Chunked object stream exceeded its expected size.");
        hasher.update(chunk);
        await this.backend.appendBinary(staging, chunk);
      }
      const actualHash = hasher.digestHex();
      if (size !== expectedSize) throw new Error(`Chunked object stream size mismatch: expected ${expectedSize}, received ${size}.`);
      if (actualHash !== expectedHash) throw new Error(`Chunked object stream SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}.`);

      if (await this.backend.exists(finalPath)) {
        if (!(await this.hasVerified(expectedHash, expectedSize))) throw new Error(`Immutable object collision at ${finalPath}.`);
        return { hash: expectedHash, size: expectedSize };
      }
      try {
        await this.backend.rename(staging, finalPath);
      } catch (error) {
        // A concurrent writer is safe only if it committed the exact immutable object.
        if (!(await this.hasVerified(expectedHash, expectedSize))) throw error;
        return { hash: expectedHash, size: expectedSize };
      }
      // The staged byte stream was already incrementally hashed before the atomic
      // rename. Re-reading a multi-gigabyte object through Obsidian DataAdapter
      // would re-materialize it in memory for no additional mutation boundary.
      const committedSize = await this.backend.statSize(finalPath);
      if (committedSize !== expectedSize) throw new Error(`Committed chunked object ${expectedHash} has size ${committedSize ?? "missing"}; expected ${expectedSize}.`);
      return { hash: expectedHash, size: expectedSize };
    } finally {
      try { await this.backend.remove(staging); } catch { /* best effort */ }
    }
  }

  async putText(text: string): Promise<StoredBlob> {
    const bytes = new TextEncoder().encode(text);
    return await this.put(toArrayBuffer(bytes));
  }

  async get(hash: string): Promise<ArrayBuffer> {
    assertHash(hash);
    const path = objectPath(hash);
    if (!(await this.backend.exists(path))) throw new Error(`Missing immutable object ${hash}.`);
    const size = await this.backend.statSize(path);
    if (size === null) throw new Error(`BASE object ${hash} has no verified file size.`);
    this.assertWithinWholeReadBudget(size);
    const data = await this.backend.readBinary(path);
    const actual = await sha256Hex(data);
    if (actual !== hash) throw new Error(`Immutable object ${hash} failed content verification.`);
    return data;
  }

  async getText(hash: string): Promise<string> {
    return new TextDecoder().decode(await this.get(hash));
  }

  async hasVerified(hash: string, expectedSize?: number): Promise<boolean> {
    assertHash(hash);
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
      throw new Error("Expected object size must be a non-negative safe integer.");
    }
    const path = objectPath(hash);
    if (!(await this.backend.exists(path))) return false;
    const actualSize = await this.backend.statSize(path);
    if (actualSize === null) return false;
    this.assertWithinWholeReadBudget(actualSize);
    if (expectedSize !== undefined && actualSize !== expectedSize) return false;
    const data = await this.backend.readBinary(path);
    if (data.byteLength !== actualSize) return false;
    return (await sha256Hex(data)) === hash;
  }

  /** Read-only filename/size inventory. Names are never treated as content verification. */
  async inspect(reachableHashes: ReadonlySet<string>): Promise<ObjectStoreInventory> {
    const root = await this.backend.list(OBJECT_DIR);
    const presentReachableHashes = new Set<string>();
    let candidates: Array<{ hash: string; path: string }> = [];
    let validObjectNames = 0;
    let totalBytes = 0;
    let unknownSizeCount = 0;
    let reachableObjectNames = 0;
    let unreferencedObjectNames = 0;
    let unreferencedBytes = 0;
    let malformedNameCount = 0;
    let unknownEntryCount = root.files.length;
    let stagingFileCount = 0;

    const inspectBatch = async (): Promise<void> => {
      const current = candidates;
      candidates = [];
      const sized = await Promise.all(current.map(async (candidate) => ({
        ...candidate,
        size: await this.backend.statSize(candidate.path)
      })));
      for (const { hash, size } of sized) {
        if (size === null) {
          unknownSizeCount += 1;
        } else {
          totalBytes += size;
        }

        if (reachableHashes.has(hash)) {
          reachableObjectNames += 1;
          presentReachableHashes.add(hash);
        } else {
          unreferencedObjectNames += 1;
          if (size !== null) unreferencedBytes += size;
        }
      }
    };

    for (const folder of root.folders) {
      if (folder === ".staging") {
        const staging = await this.backend.list(`${OBJECT_DIR}/.staging`);
        const recognizedStagingCount = staging.files.filter((name) => /^blob_[a-f0-9]{32}\.tmp$/i.test(name)).length;
        stagingFileCount += recognizedStagingCount;
        unknownEntryCount += staging.files.length - recognizedStagingCount;
        unknownEntryCount += staging.folders.length;
        continue;
      }

      if (!/^[a-f0-9]{2}$/.test(folder)) {
        unknownEntryCount += 1;
        continue;
      }

      const shard = await this.backend.list(`${OBJECT_DIR}/${folder}`);
      unknownEntryCount += shard.folders.length;
      for (const name of shard.files) {
        const match = /^([a-f0-9]{64})\.blob$/.exec(name);
        const hash = match?.[1];
        if (!hash || hash.slice(0, 2) !== folder) {
          malformedNameCount += 1;
          continue;
        }

        const path = `${OBJECT_DIR}/${folder}/${name}`;
        validObjectNames += 1;
        candidates.push({ hash, path });
        if (candidates.length === 16) await inspectBatch();
      }
    }
    if (candidates.length > 0) await inspectBatch();

    let missingReachableNames = 0;
    for (const hash of reachableHashes) {
      if (!presentReachableHashes.has(hash)) missingReachableNames += 1;
    }

    return {
      validObjectNames,
      totalBytes,
      unknownSizeCount,
      reachableObjectNames,
      missingReachableNames,
      unreferencedObjectNames,
      unreferencedBytes,
      malformedNameCount,
      unknownEntryCount,
      stagingFileCount
    };
  }

  private assertWithinWholeReadBudget(sizeBytes: number): void {
    if (sizeBytes > this.maxWholeReadBytes) {
      throw new BaselineObjectReadLimitError(sizeBytes, this.maxWholeReadBytes);
    }
  }
}

function objectPath(hash: string): string {
  assertHash(hash);
  return `${OBJECT_DIR}/${hash.slice(0, 2)}/${hash}.blob`;
}

function assertHash(hash: string): void {
  if (!isSha256Hex(hash)) throw new Error(`Invalid SHA-256 object ID: ${hash}.`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
