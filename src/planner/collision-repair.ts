import { randomId } from "../state/durable/ids";
import type { DurableState, FileReplicaInput, FileReplicaRecord } from "../state/durable/model";
import type { DurableTransaction } from "../state/durable/store";
import { deriveFileSyncStatus } from "../sync/derived-status";

/**
 * Path-identity collisions: two durable records claim the same path (for example a local-only
 * record and a remote-only record that were never paired, after another sync client replaced or
 * moved files). The records are bookkeeping only; the files themselves are fine.
 *
 * The repair re-pairs the replicas of each affected group by their exact path. It never touches
 * a file and never infers a deletion: replicas without a partner become ordinary create records,
 * and a baseline survives only where exactly one record can vouch for it.
 */
export interface CollisionRepair {
  /** Records to write (re-paired). */
  puts: FileReplicaInput[];
  /** Records that no longer exist after re-pairing. */
  removals: string[];
  /** Entry ids whose tombstones must be cleared because their replicas are alive again. */
  tombstoneEntryIds: string[];
  /** Number of colliding groups that were repaired. */
  groups: number;
  /** Groups that could not be repaired safely (letter-case/Unicode aliases of different files). */
  unrepairable: number;
}

const foldPath = (path: string): string => path.normalize("NFC").toLowerCase();

export function planCollisionRepair(state: DurableState, includePath: (path: string) => boolean = () => true): CollisionRepair | null {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const owners = new Map<string, Set<string>>();
  for (const index of [state.pathIndex, state.remotePathIndex]) {
    for (const [path, entryId] of Object.entries(index)) {
      if (!includePath(path) || !state.files[entryId]) continue;
      const key = foldPath(path);
      const group = owners.get(key) ?? new Set<string>();
      group.add(entryId);
      owners.set(key, group);
    }
  }
  const colliding = new Set<string>();
  for (const group of owners.values()) {
    if (group.size < 2) continue;
    const [first, ...rest] = [...group];
    for (const id of group) colliding.add(id);
    for (const id of rest) union(first!, id);
  }
  if (colliding.size === 0) return null;

  const components = new Map<string, FileReplicaRecord[]>();
  for (const id of colliding) {
    const root = find(id);
    const list = components.get(root) ?? [];
    list.push(state.files[id]!);
    components.set(root, list);
  }

  const repair: CollisionRepair = { puts: [], removals: [], tombstoneEntryIds: [], groups: 0, unrepairable: 0 };
  for (const members of components.values()) {
    const outcome = repairComponent(members);
    if (!outcome) { repair.unrepairable += 1; continue; }
    repair.puts.push(...outcome.puts);
    repair.removals.push(...outcome.removals);
    repair.tombstoneEntryIds.push(...members.map((member) => member.entryId));
    repair.groups += 1;
  }
  return repair.groups > 0 || repair.unrepairable > 0 ? repair : null;
}

function repairComponent(members: FileReplicaRecord[]): { puts: FileReplicaInput[]; removals: string[] } | null {
  interface Slot { local: FileReplicaRecord | null; remote: FileReplicaRecord | null }
  const slots = new Map<string, Slot>();
  const slot = (path: string): Slot => {
    let found = slots.get(path);
    if (!found) { found = { local: null, remote: null }; slots.set(path, found); }
    return found;
  };
  for (const member of members) {
    if (member.local) {
      const entry = slot(member.local.path);
      if (entry.local) return null; // two local files at one path cannot happen; refuse to guess
      entry.local = member;
    }
    if (member.remote) {
      const entry = slot(member.remote.path);
      if (entry.remote) return null;
      entry.remote = member;
    }
  }
  // After re-pairing every folded path must belong to exactly one exact path, otherwise the
  // collision is a genuine letter-case/Unicode alias of two different files.
  const folded = new Map<string, string>();
  for (const path of slots.keys()) {
    const key = foldPath(path);
    const existing = folded.get(key);
    if (existing !== undefined && existing !== path) return null;
    folded.set(key, path);
  }

  const reused = new Set<string>();
  const puts: FileReplicaInput[] = [];
  for (const [path, { local, remote }] of [...slots].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const contributors = [local, remote].filter((value): value is FileReplicaRecord => value !== null);
    const baselineOwners = contributors.filter((contributor) => contributor.baseline?.path === path);
    const baselineHashes = new Set(baselineOwners.map((owner) => owner.baseline!.blobHash));
    const baselineOwner = baselineOwners.length > 0 && baselineHashes.size === 1 ? baselineOwners[0]! : null;
    const idSource = [baselineOwner, ...contributors].find((candidate): candidate is FileReplicaRecord => Boolean(candidate) && !reused.has(candidate!.entryId));
    const entryId = idSource ? idSource.entryId : randomId("file");
    reused.add(entryId);
    const record: Omit<FileReplicaInput, "status"> = {
      entryId,
      path,
      baseline: baselineOwner?.baseline ?? null,
      local: local?.local ?? null,
      remote: remote?.remote ?? null
    };
    puts.push({ ...record, status: deriveFileSyncStatus(record) });
  }
  const removals = members.map((member) => member.entryId).filter((id) => !reused.has(id));
  return { puts, removals };
}

/** Applies a repair inside a durable transaction. */
export function applyCollisionRepair(tx: DurableTransaction, base: DurableState, repair: CollisionRepair): void {
  for (const entryId of repair.removals) tx.removeFile(entryId);
  for (const record of repair.puts) tx.putFile(record);
  const touched = new Set(repair.tombstoneEntryIds);
  for (const tombstone of Object.values(base.tombstones)) if (touched.has(tombstone.entryId)) tx.removeTombstone(tombstone.tombstoneId);
}
