import { auditConvergenceState } from "../../src/convergence/auditor";
import { mergeTextThreeWay } from "../../src/merge/text-merge";
import { SyncPlanner } from "../../src/planner/planner";
import type { FileReplicaRecord, DurableState } from "../../src/state/durable/model";
import { assertStateInvariants } from "../../src/state/durable/validation";
import { DurableStateStore } from "../../src/state/durable/store";
import { sha256Hex } from "../../src/state/durable/crypto";
import { deriveFileSyncStatus } from "../../src/sync/derived-status";
import type { Logger } from "../../src/diagnostics/logger";
import { MemoryStateBackend } from "./memory-backend";


const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MERGE_LIMITS = { maxInputBytes: 2 * 1024 * 1024, maxLines: 12_000, maxDiffCells: 8_000_000 };
const CHECKPOINT_EVERY = 2_500;

interface Replica {
  path: string;
  bytes: Uint8Array;
  hash: string;
  etag: string;
}

interface Model {
  basePath: string;
  baseBytes: Uint8Array;
  baseHash: string;
  baseRemoteFileId: string;
  baseRemoteEtag: string;
  local: Replica | null;
  remote: Replica | null;
  online: boolean;
  scopeEpoch: number;
  accountEpoch: number;
  tick: number;
}

export interface StateMachineSummary {
  seed: number;
  transitions: number;
  operations: Record<string, number>;
  safeMerges: number;
  blockedConflicts: number;
  durableRestarts: number;
  durableIntegrityChecks: number;
}

const OPERATIONS = [
  "modify-local", "modify-remote", "append-local", "append-remote", "truncate-local", "truncate-remote",
  "rename-local", "rename-remote", "delete-local", "delete-remote", "recreate-local", "recreate-remote",
  "offline", "online", "remote-timeout", "local-failure", "stale-etag", "lost-response", "partial-download",
  "partial-upload", "scope-change", "account-change", "restart"
] as const;

export async function runStateMachine(seed: number, transitions: number): Promise<StateMachineSummary> {
  const random = new SeededRandom(seed);
  const backend = new MemoryStateBackend();
  let store = await DurableStateStore.open(backend, logger);
  const state = structuredClone(store.getState());
  const fileId = "file_state_machine";
  const baseline = encoder.encode("A\nB\nC\n");
  let model: Model = {
    basePath: "Notes/StateMachine.md",
    baseBytes: baseline,
    baseHash: await sha256Hex(arrayBufferOf(baseline)),
    baseRemoteFileId: "remote-file-stage14",
    baseRemoteEtag: '"initial-remote"',
    local: null,
    remote: null,
    online: true,
    scopeEpoch: 0,
    accountEpoch: 0,
    tick: 0
  };
  model.local = await replica(model.basePath, baseline, '"initial-local"');
  model.remote = await replica(model.basePath, baseline, '"initial-remote"');

  const summary: StateMachineSummary = {
    seed, transitions, operations: Object.create(null) as Record<string, number>,
    safeMerges: 0, blockedConflicts: 0, durableRestarts: 0, durableIntegrityChecks: 0
  };
  let pendingRestart = false;

  for (let step = 0; step < transitions; step += 1) {
    const operation = OPERATIONS[random.int(0, OPERATIONS.length - 1)]!;
    summary.operations[operation] = (summary.operations[operation] ?? 0) + 1;
    model.tick += 1;
    let oneStepFailure = false;

    if (operation === "offline") model.online = false;
    else if (operation === "online") model.online = true;
    else if (operation === "scope-change") { model.scopeEpoch += 1; oneStepFailure = true; }
    else if (operation === "account-change") { model.accountEpoch += 1; oneStepFailure = true; }
    else if (operation === "restart") pendingRestart = true;
    else if (["remote-timeout", "local-failure", "stale-etag", "lost-response", "partial-download", "partial-upload"].includes(operation)) oneStepFailure = true;
    else await applyReplicaOperation(model, operation, step, random);

    const record = makeRecord(model, fileId, state.generation);
    refreshIndexedRecord(state, record);
    assertStateInvariants(state);
    const audit = auditConvergenceState(state);
    invariant(audit.errors === 0, seed, step, `durable model audit errors: ${audit.issues.map((issue) => issue.code).join(",")}`);

    const planner = new SyncPlanner();
    const plan = await planner.build(state);
    const item = plan.items[0];
    invariant(item !== undefined, seed, step, "planner omitted the active logical file");
    if (step % 31 === 0) {
      const repeated = await planner.build(state);
      invariant(plan.fingerprint === repeated.fingerprint, seed, step, "identical state produced a different deterministic plan fingerprint");
      invariant(JSON.stringify(plan.items) === JSON.stringify(repeated.items), seed, step, "identical state produced different planner items");
    }

    const deleteVersusModify = model.baseHash !== "" && Boolean(
      (!model.local && model.remote && model.remote.hash !== model.baseHash) ||
      (!model.remote && model.local && model.local.hash !== model.baseHash)
    );
    if (deleteVersusModify) {
      invariant(item.disposition === "blocked", seed, step, `delete-versus-modify became ${item.disposition}`);
      summary.blockedConflicts += 1;
    } else if (item.disposition === "blocked") {
      summary.blockedConflicts += 1;
    }

    // A one-shot injected fault makes this generated cycle stop before any simulated mutation.
    if (!oneStepFailure && model.online && item.disposition === "merge-candidate" && model.local && model.remote) {
      const localBefore = model.local.hash;
      const remoteBefore = model.remote.hash;
      const result = mergeTextThreeWay(arrayBufferOf(model.baseBytes), arrayBufferOf(model.local.bytes), arrayBufferOf(model.remote.bytes), MERGE_LIMITS);
      if (result.status === "merged") {
        const mergedBytes = new Uint8Array(result.bytes);
        const mergedHash = await sha256Hex(result.bytes);
        const finalPath = model.local.path;
        const nextLocal = await replica(finalPath, mergedBytes, `"local-${model.tick}"`, mergedHash);
        const nextRemote = await replica(finalPath, mergedBytes, `"remote-${model.tick}"`, mergedHash);
        model.local = nextLocal;
        model.remote = nextRemote;
        model.basePath = nextLocal.path;
        model.baseBytes = mergedBytes;
        model.baseHash = mergedHash;
        model.baseRemoteFileId = "remote-file-stage14";
        model.baseRemoteEtag = nextRemote.etag;
        summary.safeMerges += 1;
        const converged = makeRecord(model, fileId, state.generation);
        refreshIndexedRecord(state, converged);
        assertStateInvariants(state);
        const postMergePlan = await planner.build(state);
        invariant(postMergePlan.items[0]?.disposition === "noop", seed, step, "a verified simulated merge did not converge to a no-op plan");
      } else {
        invariant(model.local.hash === localBefore && model.remote.hash === remoteBefore, seed, step, "a blocked merge changed a replica");
        summary.blockedConflicts += 1;
      }
    }

    if ((step + 1) % CHECKPOINT_EVERY === 0) {
      const current = makeRecord(model, fileId, state.generation);
      const baseObject = await store.putBlob(arrayBufferOf(model.baseBytes));
      invariant(baseObject.hash === model.baseHash, seed, step, "durable BASE bytes failed exact SHA-256 verification");
      await store.transact("stage14-state-machine", (tx) => tx.putFile({
        ...current,
        baseline: { ...current.baseline!, blobHash: baseObject.hash, size: baseObject.size }
      }));
      store = await DurableStateStore.open(backend, logger);
      const firstRecovery = await store.verifyIntegrity();
      invariant(firstRecovery.ok, seed, step, `durable restart integrity failed: ${firstRecovery.errors.slice(0, 2).join("; ")}`);
      summary.durableIntegrityChecks += 1;
      if (pendingRestart) {
        const secondOpen = await DurableStateStore.open(backend, logger);
        const secondRecovery = await secondOpen.verifyIntegrity();
        invariant(secondRecovery.ok && secondRecovery.generation === firstRecovery.generation && secondRecovery.walSequence === firstRecovery.walSequence,
          seed, step, "repeated recovery changed the recovered durable position");
        summary.durableIntegrityChecks += 1;
        summary.durableRestarts += 1;
        pendingRestart = false;
        store = secondOpen;
      }
      replaceState(state, store.getState());
      refreshIndexedRecord(state, makeRecord(model, fileId, state.generation));
    }
  }

  const finalRecord = makeRecord(model, fileId, state.generation);
  const finalPlan = await new SyncPlanner().build({ ...state, files: { [fileId]: finalRecord } });
  invariant(finalPlan.items.length === 1, seed, transitions, "final state did not remain reviewable as one logical record");
  return summary;
}

async function applyReplicaOperation(model: Model, operation: string, step: number, random: SeededRandom): Promise<void> {
  const match = /^(modify|append|truncate|rename|delete|recreate)-(local|remote)$/.exec(operation);
  if (!match) return;
  const action = match[1]!;
  const side = match[2] === "local" ? "local" : "remote";
  const current = model[side];
  if (action === "delete") { model[side] = null; return; }
  if (action === "rename") {
    const path = `Archive/${side}-${step}.md`;
    model[side] = await replica(path, current?.bytes ?? model.baseBytes, `"${side}-${model.tick}"`);
    return;
  }
  if (action === "recreate" && current) return;
  const priorBytes = current?.bytes ?? model.baseBytes;
  let text = decoder.decode(priorBytes);
  if (action === "modify") {
    const lines = text.split("\n");
    const target = random.int(0, 2);
    lines[target] = `${side.toUpperCase()}-${step}`;
    text = lines.join("\n");
  } else if (action === "append") {
    text = `${text}${text.endsWith("\n") ? "" : "\n"}${side.toUpperCase()}-APPEND-${step}\n`;
  } else if (action === "truncate") {
    text = "";
  } else if (action === "recreate") {
    text = `RECREATED-${side}-${step}\n`;
  }
  const path = current?.path ?? model.basePath;
  model[side] = await replica(path, encoder.encode(text), `"${side}-${model.tick}"`);
}

async function replica(path: string, bytes: Uint8Array, etag: string, knownHash?: string): Promise<Replica> {
  return { path, bytes: bytes.slice(), hash: knownHash ?? await sha256Hex(arrayBufferOf(bytes)), etag };
}

function makeRecord(model: Model, entryId: string, generation: string): FileReplicaRecord {
  const path = model.local?.path ?? model.remote?.path ?? model.basePath;
  const record: FileReplicaRecord = {
    entryId,
    path,
    generation,
    baseline: {
      blobHash: model.baseHash,
      size: model.baseBytes.byteLength,
      createdAt: "2026-01-01T00:00:00.000Z",
      path: model.basePath,
      remoteFileId: model.baseRemoteFileId,
      remoteEtag: model.baseRemoteEtag
    },
    local: model.local ? { path: model.local.path, contentHash: model.local.hash, size: model.local.bytes.byteLength, mtimeMs: model.tick } : null,
    remote: model.remote ? { path: model.remote.path, contentHash: model.remote.hash, reportedSha256: null, etag: model.remote.etag, fileId: "remote-file-stage14", size: model.remote.bytes.byteLength, mtimeMs: model.tick } : null,
    status: "conflict"
  };
  record.status = deriveFileSyncStatus(record);
  return record;
}

function refreshIndexedRecord(state: DurableState, candidate: FileReplicaRecord): void {
  candidate.status = deriveFileSyncStatus(candidate);
  const previous = state.files[candidate.entryId];
  if (previous) {
    for (const index of [state.pathIndex, state.remotePathIndex, state.remoteFileIdIndex]) {
      for (const [key, value] of Object.entries(index)) if (value === candidate.entryId) delete index[key];
    }
  }
  state.files[candidate.entryId] = candidate;
  if (candidate.local) state.pathIndex[candidate.local.path] = candidate.entryId;
  if (candidate.remote) {
    state.remotePathIndex[candidate.remote.path] = candidate.entryId;
    if (candidate.remote.fileId) state.remoteFileIdIndex[candidate.remote.fileId] = candidate.entryId;
  }
}

function replaceState(target: DurableState, source: DurableState): void {
  target.schemaVersion = source.schemaVersion;
  target.storeId = source.storeId;
  target.generation = source.generation;
  target.createdAt = source.createdAt;
  target.updatedAt = source.updatedAt;
  target.lastWalSequence = source.lastWalSequence;
  target.lastWalHash = source.lastWalHash;
  target.files = structuredClone(source.files);
  target.pathIndex = structuredClone(source.pathIndex);
  target.remotePathIndex = structuredClone(source.remotePathIndex);
  target.remoteFileIdIndex = structuredClone(source.remoteFileIdIndex);
  target.tombstones = structuredClone(source.tombstones);
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice();
  return copy.buffer as ArrayBuffer;
}

function invariant(condition: unknown, seed: number, step: number, message: string): asserts condition {
  if (!condition) throw new Error(`State machine failed (seed=${seed}, step=${step}): ${message}`);
}

class SeededRandom {
  private value: number;
  constructor(seed: number) { this.value = (seed >>> 0) || 0x6d2b79f5; }
  next(): number {
    let value = this.value += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  }
  int(minimum: number, maximum: number): number { return minimum + Math.floor(this.next() * (maximum - minimum + 1)); }
}

