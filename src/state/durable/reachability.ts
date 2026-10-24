import type { WalEvent } from "./wal";
import type { DurableState } from "./model";

/**
 * Collects object-store roots without making any deletion decision. The full WAL
 * remains replayable from sequence 1, so every baseline value recorded in it is
 * still a retention root until a future checkpoint protocol proves otherwise.
 */
export function collectStateBlobReferences(state: DurableState, into: Set<string>): void {
  for (const record of Object.values(state.files)) {
    if (record.baseline) into.add(record.baseline.blobHash);
  }
  for (const tombstone of Object.values(state.tombstones)) {
    if (tombstone.previousBlobHash) into.add(tombstone.previousBlobHash);
  }
}

export function collectWalBlobReferences(event: WalEvent, into: Set<string>): void {
  if (event.kind !== "transaction-commit") return;
  for (const mutation of event.mutations) {
    if (mutation.kind === "put-file" && mutation.record.baseline) {
      into.add(mutation.record.baseline.blobHash);
    } else if (mutation.kind === "put-tombstone" && mutation.record.previousBlobHash) {
      into.add(mutation.record.previousBlobHash);
    }
  }
}
