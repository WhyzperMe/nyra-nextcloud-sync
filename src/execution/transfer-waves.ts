import type { SyncPlanItem } from "../planner/types";
import type { FileReplicaRecord } from "../state/durable/model";

/** Explicit caps for concurrent jobs and their conservatively estimated live buffers. */
export interface TransferWaveLimits { workers: number; bytes: number; chunkBytes: number }

/**
 * Builds order-preserving waves. Only straightforward transfer-and-baseline items can
 * overlap; all moves, merges, verification-only work and destructive steps are barriers.
 * A conflicting item starts the next wave rather than overtaking earlier work.
 */
export function transferWaves(
  items: readonly SyncPlanItem[], records: ReadonlyMap<string, FileReplicaRecord>, limits: TransferWaveLimits
): SyncPlanItem[][] {
  for (const value of [limits.workers, limits.bytes, limits.chunkBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Transfer wave limits must be positive safe integers.");
  }
  const waves: SyncPlanItem[][] = [];
  let current: SyncPlanItem[] = [];
  let currentBytes = 0;
  const flush = () => { if (current.length) waves.push(current); current = []; currentBytes = 0; };
  for (const item of items) {
    const record = records.get(item.entryId);
    if (!record || !parallelEligible(item) || (record.remote && (!record.remote.fileId || !record.remote.etag))) {
      flush(); waves.push([item]); continue;
    }
    const weight = estimateTransferBytes(record, limits);
    if (current.length >= limits.workers || currentBytes + weight > limits.bytes ||
        current.some((other) => conflicts(item, record, other, records.get(other.entryId)!))) flush();
    current.push(item);
    currentBytes += weight;
  }
  flush();
  return waves;
}

export function parallelEligible(item: SyncPlanItem): boolean {
  if (item.disposition !== "ready") return false;
  const transfers = item.steps.filter((step) => ["upload-create", "upload-update", "download-create", "download-update"].includes(step.kind));
  return transfers.length === 1 && item.steps.every((step) => !step.destructive &&
    (step === transfers[0] || step.kind === "establish-baseline"));
}

export function estimateTransferBytes(record: FileReplicaRecord, limits: TransferWaveLimits): number {
  const size = Math.max(record.local?.size ?? 0, record.remote?.size ?? 0, record.baseline?.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0) return limits.bytes;
  // Whole-file adapter copies, hashing/read-back and an in-flight network chunk.
  return Math.min(limits.bytes, Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, size * 4 + Math.min(size, limits.chunkBytes))));
}

export function conflicts(a: SyncPlanItem, ar: FileReplicaRecord, b: SyncPlanItem, br: FileReplicaRecord): boolean {
  if (a.entryId === b.entryId || (ar.remote?.fileId && ar.remote.fileId === br.remote?.fileId)) return true;
  const paths = (item: SyncPlanItem, record: FileReplicaRecord): string[] => [
    item.displayPath, item.localPath, item.remotePath, item.baselinePath,
    record.path, record.local?.path, record.remote?.path, record.baseline?.path,
    ...item.steps.flatMap((step) => [step.sourcePath, step.targetPath])
  ].filter((path): path is string => typeof path === "string" && path.length > 0)
    .map((path) => path.normalize("NFC").toLowerCase());
  const left = paths(a, ar), right = paths(b, br);
  return left.some((x) => right.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}

/** FIFO admission: a free worker starts the next independent item without waiting for a whole wave. */
export async function runTransferQueue<T>(
  items: readonly SyncPlanItem[], records: ReadonlyMap<string, FileReplicaRecord>, limits: TransferWaveLimits,
  worker: (item: SyncPlanItem) => Promise<T>
): Promise<T[]> {
  for (const value of [limits.workers, limits.bytes, limits.chunkBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Transfer queue limits must be positive safe integers.");
  }
  type Job = { index: number; item: SyncPlanItem; record: FileReplicaRecord | undefined; weight: number; exclusive: boolean; done: Promise<{ index: number; error?: unknown }> };
  const active = new Map<number, Job>();
  const output = new Array<T>(items.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  let next = 0, used = 0;
  while (next < items.length || active.size > 0) {
    while (errors.length === 0 && next < items.length && active.size < limits.workers) {
      const item = items[next]!;
      const record = records.get(item.entryId);
      const exclusive = !record || !parallelEligible(item) || Boolean(record.remote && (!record.remote.fileId || !record.remote.etag));
      const weight = record && !exclusive ? estimateTransferBytes(record, limits) : limits.bytes;
      if (active.size && (exclusive || used + weight > limits.bytes || [...active.values()].some((job) =>
        job.exclusive || !record || !job.record || conflicts(item, record, job.item, job.record)))) break;
      const index = next++;
      const done = Promise.resolve().then(() => worker(item)).then(
        (value) => { output[index] = value; return { index }; },
        (error: unknown) => { errors.push({ index, error }); return { index, error }; }
      );
      active.set(index, { index, item, record, weight, exclusive, done });
      used += weight;
    }
    if (!active.size) break;
    const settled = await Promise.race([...active.values()].map((job) => job.done));
    const job = active.get(settled.index)!;
    active.delete(settled.index);
    used -= job.weight;
  }
  if (errors.length) throw errors.sort((a, b) => a.index - b.index)[0]!.error;
  return output;
}
