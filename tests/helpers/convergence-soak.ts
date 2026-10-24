import { auditConvergenceState } from "../../src/convergence/auditor";
import { mergeTextThreeWay } from "../../src/merge/text-merge";
import { SyncPlanner } from "../../src/planner/planner";
import { sha256Hex } from "../../src/state/durable/crypto";
import { createEmptyState, type DurableState, type FileReplicaRecord } from "../../src/state/durable/model";
import { deriveFileSyncStatus } from "../../src/sync/derived-status";

const enc = new TextEncoder();
const dec = new TextDecoder();
const limits = { maxInputBytes: 2 * 1024 * 1024, maxLines: 12_000, maxDiffCells: 8_000_000 };

export interface SoakSummary {
  seed: number;
  rounds: number;
  mergeCandidates: number;
  merged: number;
  blockedMerges: number;
  blockedPlans: number;
  readyPlans: number;
  deterministicPlans: number;
}

export async function runConvergenceSoak(seed: number, rounds: number): Promise<SoakSummary> {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Soak seed must be a non-negative safe integer.");
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100_000) throw new Error("Soak rounds must be 1..100000.");
  const rng = new Rng(seed);
  const planner = new SyncPlanner();
  const summary: SoakSummary = { seed, rounds, mergeCandidates: 0, merged: 0, blockedMerges: 0, blockedPlans: 0, readyPlans: 0, deterministicPlans: 0 };

  for (let round = 0; round < rounds; round += 1) {
    const scenario = await buildScenario(rng, round);
    const first = await planner.build(scenario.state);
    const second = await planner.build(scenario.state);
    assert(first.fingerprint === second.fingerprint, seed, round, "Planner fingerprint changed for identical durable state.");
    assert(JSON.stringify(first.items) === JSON.stringify(second.items), seed, round, "Planner items changed for identical durable state.");
    summary.deterministicPlans += 1;

    const quick = auditConvergenceState(scenario.state);
    // Dirty/conflicting records are valid durable facts. The audit may warn about
    // legacy cached status, but it must not report semantic corruption here.
    assert(quick.errors === 0, seed, round, `Generated valid state failed convergence audit: ${quick.issues.map((i) => i.code).join(",")}`);

    const item = first.items[0];
    assert(item !== undefined, seed, round, "Planner produced no item for a one-record state.");
    if (item.disposition === "merge-candidate") {
      summary.mergeCandidates += 1;
      const result = mergeTextThreeWay(scenario.baseBytes, scenario.localBytes!, scenario.remoteBytes!, limits);
      const swapped = mergeTextThreeWay(scenario.baseBytes, scenario.remoteBytes!, scenario.localBytes!, limits);
      assert(result.status === swapped.status, seed, round, "Three-way merge is not symmetric in status.");
      if (result.status === "merged") {
        summary.merged += 1;
        assert(swapped.status === "merged", seed, round, "Swapped merge unexpectedly blocked.");
        assert(equalBytes(result.bytes, swapped.bytes), seed, round, "Conflict-free merge output depends on LOCAL/REMOTE ordering.");
        const text = dec.decode(result.bytes);
        for (const token of scenario.requiredTokens) assert(text.includes(token), seed, round, `Merged output lost token '${token}'.`);
      } else {
        summary.blockedMerges += 1;
      }
    } else if (item.disposition === "blocked") {
      summary.blockedPlans += 1;
    } else if (item.disposition === "ready" || item.disposition === "noop" || item.disposition === "needs-verification") {
      summary.readyPlans += 1;
    }

    // Strong conflict rules: divergent dual rename and delete-vs-modify must not
    // ever become executable merely because randomized content happened to match.
    if (scenario.expectedHardBlock) {
      assert(item.disposition === "blocked", seed, round, `Hard-conflict scenario became ${item.disposition}/${item.classification}.`);
    }
  }
  return summary;
}

interface Scenario {
  state: DurableState;
  baseBytes: ArrayBuffer;
  localBytes: ArrayBuffer | null;
  remoteBytes: ArrayBuffer | null;
  requiredTokens: string[];
  expectedHardBlock: boolean;
}

async function buildScenario(rng: Rng, round: number): Promise<Scenario> {
  const lineCount = rng.int(8, 40);
  const baseLines = Array.from({ length: lineCount }, (_, i) => `R${round}-L${i}`);
  const baseBytes = enc.encode(`${baseLines.join("\n")}\n`).buffer;
  const baseHash = await sha256Hex(baseBytes);
  const baselinePath = `Notes/Soak-${round}.md`;
  const mode = rng.int(0, 11);
  let localPath = baselinePath;
  let remotePath = baselinePath;
  let localBytes: ArrayBuffer | null = baseBytes.slice(0);
  let remoteBytes: ArrayBuffer | null = baseBytes.slice(0);
  const requiredTokens: string[] = [];
  let expectedHardBlock = false;

  if (mode === 0) {
    // No-op.
  } else if (mode === 1) {
    const token = `LOCAL-${round}`; localBytes = editLine(baseLines, rng.int(0, lineCount - 1), token); requiredTokens.push(token);
  } else if (mode === 2) {
    const token = `REMOTE-${round}`; remoteBytes = editLine(baseLines, rng.int(0, lineCount - 1), token); requiredTokens.push(token);
  } else if (mode === 3 || mode === 4) {
    const left = rng.int(0, lineCount - 1);
    let right = mode === 4 ? left : rng.int(0, lineCount - 1);
    if (mode === 3 && right === left) right = (right + 1) % lineCount;
    const lt = `LOCAL-${round}`; const rt = `REMOTE-${round}`;
    localBytes = editLine(baseLines, left, lt); remoteBytes = editLine(baseLines, right, rt);
    requiredTokens.push(lt, rt);
  } else if (mode === 5) {
    localPath = `Archive/Soak-${round}.md`;
  } else if (mode === 6) {
    remotePath = `Remote/Soak-${round}.md`;
  } else if (mode === 7) {
    localPath = `Left/Soak-${round}.md`; remotePath = `Right/Soak-${round}.md`; expectedHardBlock = true;
  } else if (mode === 8) {
    localBytes = null;
    remoteBytes = editLine(baseLines, rng.int(0, lineCount - 1), `REMOTE-AFTER-LOCAL-DELETE-${round}`);
    expectedHardBlock = true;
  } else if (mode === 9) {
    remoteBytes = null;
    localBytes = editLine(baseLines, rng.int(0, lineCount - 1), `LOCAL-AFTER-REMOTE-DELETE-${round}`);
    expectedHardBlock = true;
  } else if (mode === 10) {
    localPath = `Archive/Soak-${round}.md`;
    const token = `REMOTE-CONTENT-${round}`; remoteBytes = editLine(baseLines, rng.int(0, lineCount - 1), token); requiredTokens.push(token);
  } else {
    remotePath = `Archive/Soak-${round}.md`;
    const token = `LOCAL-CONTENT-${round}`; localBytes = editLine(baseLines, rng.int(0, lineCount - 1), token); requiredTokens.push(token);
  }

  const localHash = localBytes ? await sha256Hex(localBytes) : null;
  const remoteHash = remoteBytes ? await sha256Hex(remoteBytes) : null;
  const state = createEmptyState(`store_soak_${String(round).padStart(8, "0")}`);
  const record: FileReplicaRecord = {
    entryId: `file_soak_${String(round).padStart(8, "0")}`,
    path: localBytes ? localPath : remoteBytes ? remotePath : baselinePath,
    generation: "0",
    baseline: {
      blobHash: baseHash,
      size: baseBytes.byteLength,
      createdAt: "2026-01-01T00:00:00.000Z",
      path: baselinePath,
      remoteFileId: `rid-${round}`,
      remoteEtag: `\"base-${round}\"`
    },
    local: localBytes ? { path: localPath, contentHash: localHash!, size: localBytes.byteLength, mtimeMs: 10 + round } : null,
    remote: remoteBytes ? { path: remotePath, contentHash: remoteHash, reportedSha256: null, etag: `\"remote-${round}\"`, fileId: `rid-${round}`, size: remoteBytes.byteLength, mtimeMs: 20 + round } : null,
    status: "conflict"
  };
  record.status = deriveFileSyncStatus(record);
  state.files[record.entryId] = record;
  if (record.local) state.pathIndex[record.local.path] = record.entryId;
  if (record.remote) {
    state.remotePathIndex[record.remote.path] = record.entryId;
    if (record.remote.fileId) state.remoteFileIdIndex[record.remote.fileId] = record.entryId;
  }
  return { state, baseBytes, localBytes, remoteBytes, requiredTokens, expectedHardBlock };
}

function editLine(base: readonly string[], index: number, token: string): ArrayBuffer {
  const lines = [...base]; lines[index] = token; return enc.encode(`${lines.join("\n")}\n`).buffer;
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b); if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

class Rng {
  private state: number;
  constructor(seed: number) { this.state = (seed >>> 0) || 0x6d2b79f5; }
  next(): number {
    let t = this.state += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
}

function assert(condition: unknown, seed: number, round: number, message: string): asserts condition {
  if (!condition) throw new Error(`Convergence soak failed (seed=${seed}, round=${round}): ${message}`);
}
