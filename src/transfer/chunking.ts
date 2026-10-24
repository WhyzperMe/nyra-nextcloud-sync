const MIB = 1024 * 1024;
export const NEXTCLOUD_MIN_CHUNK_BYTES = 5 * MIB;
export const NEXTCLOUD_MAX_CHUNK_BYTES = 5 * 1024 * MIB;
export const NEXTCLOUD_MAX_CHUNKS = 10_000;

export interface ChunkPlan {
  chunkSize: number;
  chunkCount: number;
}

export function planNextcloudChunks(totalBytes: number, preferredChunkBytes: number): ChunkPlan {
  assertSafeSize(totalBytes, "totalBytes");
  assertSafeSize(preferredChunkBytes, "preferredChunkBytes");
  if (totalBytes === 0) return { chunkSize: NEXTCLOUD_MIN_CHUNK_BYTES, chunkCount: 1 };

  const preferred = Math.max(NEXTCLOUD_MIN_CHUNK_BYTES, preferredChunkBytes);
  const minimumForCount = Math.ceil(totalBytes / NEXTCLOUD_MAX_CHUNKS);
  const raw = Math.max(preferred, minimumForCount);
  const chunkSize = roundUp(raw, MIB);
  if (chunkSize > NEXTCLOUD_MAX_CHUNK_BYTES) {
    throw new Error(`File requires a chunk larger than Nextcloud's 5 GiB chunk limit (${chunkSize} bytes).`);
  }
  const chunkCount = Math.ceil(totalBytes / chunkSize);
  if (chunkCount < 1 || chunkCount > NEXTCLOUD_MAX_CHUNKS) {
    throw new Error(`Chunk plan would require ${chunkCount} chunks; Nextcloud allows at most ${NEXTCLOUD_MAX_CHUNKS}.`);
  }
  return { chunkSize, chunkCount };
}

export function chunkBounds(index: number, totalBytes: number, chunkSize: number): { start: number; endExclusive: number; size: number } {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Chunk index must be a non-negative safe integer.");
  assertSafeSize(totalBytes, "totalBytes");
  assertSafeSize(chunkSize, "chunkSize");
  if (chunkSize <= 0) throw new Error("chunkSize must be positive.");
  const start = index * chunkSize;
  if (!Number.isSafeInteger(start) || start > totalBytes) throw new Error("Chunk index is outside the file.");
  const endExclusive = Math.min(totalBytes, start + chunkSize);
  return { start, endExclusive, size: endExclusive - start };
}

export function nextcloudChunkName(index: number): string {
  const oneBased = index + 1;
  if (!Number.isSafeInteger(oneBased) || oneBased < 1 || oneBased > NEXTCLOUD_MAX_CHUNKS) {
    throw new Error(`Invalid Nextcloud chunk number ${oneBased}.`);
  }
  return String(oneBased).padStart(5, "0");
}

function roundUp(value: number, quantum: number): number {
  return Math.ceil(value / quantum) * quantum;
}

function assertSafeSize(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
}
