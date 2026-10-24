import { canonicalStringify } from "../state/durable/canonical-json";
import { sha256Hex } from "../state/durable/crypto";
import type { DurableState } from "../state/durable/model";
import { classifyRecord, type PlannerCollisionContext } from "./classifier";
import { SYNC_PLAN_VERSION, type SyncPlan, type SyncPlanItem, type SyncPlanSummary } from "./types";

/** Pure, deterministic BASE/LOCAL/REMOTE planner. It performs zero I/O. */
export class SyncPlanner {
  async build(state: DurableState, includePath: (path: string) => boolean = () => true): Promise<SyncPlan> {
    const collisions = detectCrossIdentityPathCollisions(state, includePath);
    const items = Object.values(state.files)
      .filter((record) => recordIsInScope(record, includePath))
      .map((record) => classifyRecord(record, collisions))
      .sort(compareItems);
    const summary = summarize(items);
    const fingerprint = await fingerprintSyncPlan({
      version: SYNC_PLAN_VERSION,
      storeId: state.storeId,
      stateGeneration: state.generation,
      walSequence: state.lastWalSequence,
      walHash: state.lastWalHash,
      items
    });
    return {
      version: SYNC_PLAN_VERSION,
      createdAt: new Date().toISOString(),
      storeId: state.storeId,
      stateGeneration: state.generation,
      walSequence: state.lastWalSequence,
      walHash: state.lastWalHash,
      fingerprint,
      items,
      summary
    };
  }
}

export async function fingerprintSyncPlan(
  plan: Pick<SyncPlan, "version" | "storeId" | "stateGeneration" | "walSequence" | "walHash" | "items">
): Promise<string> {
  return await sha256Hex(canonicalStringify({
    version: plan.version,
    storeId: plan.storeId,
    stateGeneration: plan.stateGeneration,
    walSequence: plan.walSequence,
    walHash: plan.walHash,
    items: plan.items
  }));
}

function detectCrossIdentityPathCollisions(state: DurableState, includePath: (path: string) => boolean): PlannerCollisionContext {
  const colliding = new Set<string>();
  const paths = new Map<string, string[]>();
  const owners = new Map<string, Array<{ entryId: string; path: string }>>();
  for (const index of [state.pathIndex, state.remotePathIndex]) {
    for (const [path, entryId] of Object.entries(index)) {
      if (!includePath(path)) continue;
      // NFC + locale-independent case folding conservatively protects common
      // Windows/macOS aliases without rewriting the user's actual paths.
      const key = path.normalize("NFC").toLowerCase();
      const group = owners.get(key) ?? [];
      group.push({ entryId, path });
      owners.set(key, group);
    }
  }
  const marked = new Set<string>();
  const blockGroup = (key: string): void => {
    if (marked.has(key)) return;
    marked.add(key);
    for (const owner of owners.get(key) ?? []) {
      colliding.add(owner.entryId);
      push(paths, owner.entryId, owner.path);
    }
  };
  for (const [key, group] of owners) {
    if (new Set(group.map((owner) => owner.entryId)).size > 1) blockGroup(key);
    // A file cannot simultaneously be the parent directory of another file.
    let slash = key.lastIndexOf("/");
    while (slash >= 0) {
      const parent = key.slice(0, slash);
      if (owners.has(parent)) { blockGroup(parent); blockGroup(key); }
      slash = key.lastIndexOf("/", slash - 1);
    }
  }
  return {
    collidingEntryIds: colliding,
    collisionPathsByEntryId: paths,
    deletedEntryIds: new Set(Object.values(state.tombstones).map((tombstone) => tombstone.entryId))
  };
}

export function recordIsInScope(record: DurableState["files"][string], includePath: (path: string) => boolean): boolean {
  const paths = [record.local?.path, record.remote?.path, record.baseline?.path].filter((value): value is string => typeof value === "string");
  if (paths.length === 0) return includePath(record.path);
  // If either replica crosses a scope boundary, keep the record visible so a
  // rename cannot silently escape policy. Fully excluded records stay dormant.
  return paths.some(includePath);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    if (!existing.includes(value)) existing.push(value);
  } else map.set(key, [value]);
}

function summarize(items: readonly SyncPlanItem[]): SyncPlanSummary {
  let noop = 0, ready = 0, needsVerification = 0, mergeCandidates = 0, blocked = 0, destructiveSteps = 0, remoteVerifications = 0;
  for (const item of items) {
    if (item.disposition === "noop") noop += 1;
    else if (item.disposition === "ready") ready += 1;
    else if (item.disposition === "needs-verification") needsVerification += 1;
    else if (item.disposition === "merge-candidate") mergeCandidates += 1;
    else blocked += 1;
    for (const step of item.steps) {
      if (step.destructive) destructiveSteps += 1;
      if (step.kind === "verify-remote-content") remoteVerifications += 1;
    }
  }
  return { total: items.length, noop, ready, needsVerification, mergeCandidates, blocked, destructiveSteps, remoteVerifications };
}

function compareItems(a: SyncPlanItem, b: SyncPlanItem): number {
  const path = ordinalCompare(a.displayPath, b.displayPath);
  return path !== 0 ? path : ordinalCompare(a.entryId, b.entryId);
}

function ordinalCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
