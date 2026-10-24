import { coalesceExactRenames } from "./rename-hints";
import type { LocalRenameHint, RenameKind } from "./types";

interface MutationEvent {
  sequence: number;
  rename: LocalRenameHint | null;
}

export interface MutationDelta {
  fromSequence: number;
  toSequence: number;
  changed: boolean;
  complete: boolean;
  renames: LocalRenameHint[];
}

/**
 * Synchronous bounded event fence. It is not an event-sourced database; it only proves whether a scan
 * overlapped live Vault mutations and retains exact rename identity hints while that proof is complete.
 */
export class LocalMutationLedger {
  private sequence = 0;
  private readonly events: MutationEvent[] = [];

  constructor(private readonly maxRetainedEvents = 8192) {
    if (!Number.isSafeInteger(maxRetainedEvents) || maxRetainedEvents < 16) {
      throw new Error("Mutation ledger capacity must be a safe integer >= 16.");
    }
  }

  currentSequence(): number {
    return this.sequence;
  }

  notePathChange(): number {
    return this.append(null);
  }

  noteTreeChange(): number {
    return this.append(null);
  }

  noteRename(oldPath: string, newPath: string, kind: RenameKind): number {
    if (oldPath === newPath) return this.sequence;
    return this.append({
      oldPath,
      newPath,
      kind,
      source: "vault-event",
      confidence: "exact"
    });
  }

  changesSince(fence: number): MutationDelta {
    if (!Number.isSafeInteger(fence) || fence < 0 || fence > this.sequence) {
      throw new Error("Mutation ledger fence is outside the current sequence range.");
    }
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    const complete = fence >= oldest - 1;
    const relevant = this.events.filter((event) => event.sequence > fence);
    const renames = complete
      ? coalesceExactRenames(
          relevant.flatMap((event) => (event.rename ? [event.rename] : []))
        )
      : [];
    return {
      fromSequence: fence,
      toSequence: this.sequence,
      changed: this.sequence > fence,
      complete,
      renames
    };
  }

  private append(rename: LocalRenameHint | null): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Mutation ledger sequence exhausted; reload the plugin to reset the observation epoch.");
    }
    this.sequence += 1;
    this.events.push({ sequence: this.sequence, rename });
    while (this.events.length > this.maxRetainedEvents) this.events.shift();
    return this.sequence;
  }
}
