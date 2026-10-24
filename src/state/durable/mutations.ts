import { incrementCounter } from "./ids";
import type { DurableMutation, DurableState } from "./model";
import { assertStateId, assertStateInvariants, rebuildIndexes, validateFileRecord, validateTombstone } from "./validation";

/**
 * Pure durable-state reducer. Replica path indexes are rebuilt from canonical
 * file records after the mutation batch, which keeps index maintenance simple,
 * deterministic, and resistant to partial rename/update bugs.
 */
export function applyMutations(
  base: DurableState,
  mutations: readonly DurableMutation[],
  newGeneration: string,
  now: string
): DurableState {
  if (newGeneration !== incrementCounter(base.generation)) {
    throw new Error(`Generation transition must increment by one (${base.generation} -> ${newGeneration}).`);
  }

  const next = structuredClone(base);
  next.generation = newGeneration;
  next.updatedAt = now;

  for (const mutation of mutations) {
    switch (mutation.kind) {
      case "put-file": {
        validateFileRecord(mutation.record);
        if (mutation.record.generation !== newGeneration) {
          throw new Error("put-file record generation does not match the transaction generation.");
        }
        defineMapValue(next.files, mutation.record.entryId, structuredClone(mutation.record));
        break;
      }
      case "remove-file": {
        assertStateId(mutation.entryId, "remove-file entryId");
        delete next.files[mutation.entryId];
        break;
      }
      case "put-tombstone": {
        validateTombstone(mutation.record);
        if (mutation.record.generation !== newGeneration) {
          throw new Error("put-tombstone record generation does not match the transaction generation.");
        }
        defineMapValue(next.tombstones, mutation.record.tombstoneId, structuredClone(mutation.record));
        break;
      }
      case "remove-tombstone": {
        assertStateId(mutation.tombstoneId, "remove-tombstone tombstoneId");
        delete next.tombstones[mutation.tombstoneId];
        break;
      }
      default: {
        const exhaustive: never = mutation;
        throw new Error(`Unsupported durable mutation: ${String(exhaustive)}`);
      }
    }
  }

  rebuildIndexes(next);
  assertStateInvariants(next);
  return next;
}

function defineMapValue<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
