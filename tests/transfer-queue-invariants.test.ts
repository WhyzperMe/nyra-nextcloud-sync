import { describe, expect, it } from "vitest";
import { runTransferQueue } from "../src/execution/transfer-waves";
import type { SyncPlanItem, SyncPlanStep } from "../src/planner/types";
import type { FileReplicaRecord } from "../src/state/durable/model";

/** Small deterministic PRNG so a failing seed can be replayed exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = ["Notes/a.md", "notes/A.md", "Notes/b.md", "Notes/sub/c.md", "Notes/sub", "Ünï/x.md", "Ünï/x.md", "Other/d.md", "e.md", "E.MD"];
const limits = { workers: 3, bytes: 4_000, chunkBytes: 200 };

interface Spec { item: SyncPlanItem; record: FileReplicaRecord | undefined; eligible: boolean; weight: number }

function step(kind: SyncPlanStep["kind"], path: string, destructive = false): SyncPlanStep {
  return { kind, sourcePath: path, targetPath: path, destructive, requiresFreshRemoteEtag: false, description: kind };
}

function build(random: () => number, count: number): Spec[] {
  const specs: Spec[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = PATHS[Math.floor(random() * PATHS.length)]!;
    const size = Math.floor(random() * random() * 1_500);
    const roll = random();
    const entryId = `entry-${index}`;
    const shape = roll < 0.62 ? "transfer" : roll < 0.7 ? "transfer-baseline" : roll < 0.78 ? "move" : roll < 0.84 ? "delete" : roll < 0.9 ? "two-transfers"
      : roll < 0.94 ? "no-identity" : roll < 0.97 ? "verify" : "unknown";
    const kind: SyncPlanStep["kind"] = random() < 0.5 ? "upload-update" : "download-update";
    const steps: SyncPlanStep[] =
      shape === "move" ? [step("move-local", path)]
      : shape === "delete" ? [step("delete-local", path, true)]
      : shape === "two-transfers" ? [step("upload-update", path), step("download-update", path)]
      : shape === "verify" ? [step("verify-remote-content", path)]
      : shape === "transfer-baseline" ? [step(kind, path), step("establish-baseline", path)]
      : [step(kind, path)];
    const item: SyncPlanItem = {
      entryId, displayPath: path, localPath: path, remotePath: path, baselinePath: path, classification: "local-change",
      disposition: shape === "verify" ? "needs-verification" : "ready", reasons: [], steps,
      localChanged: true, remoteChanged: false, localPathChanged: false, remotePathChanged: false, remoteIdentityChanged: false, remoteContentKnown: true
    };
    const fileId = shape === "no-identity" ? null : random() < 0.1 ? "shared-file-id" : `fid-${index}`;
    const record: FileReplicaRecord = {
      entryId, generation: "1", path, status: "local-dirty", baseline: null,
      local: { path, contentHash: "a".repeat(64), size, mtimeMs: 1 },
      remote: { path, contentHash: null, reportedSha256: null, etag: '"e"', fileId, size, mtimeMs: 1 }
    };
    const eligible = (shape === "transfer" || shape === "transfer-baseline") && fileId !== null;
    // shape "unknown" has no record at all, so it can never be eligible.
    const weight = eligible ? Math.min(limits.bytes, Math.max(1, size * 4 + Math.min(size, limits.chunkBytes))) : limits.bytes;
    specs.push({ item, record: shape === "unknown" ? undefined : record, eligible, weight });
  }
  return specs;
}

const fold = (path: string): string => path.normalize("NFC").toLowerCase();
function overlap(a: string, b: string): boolean { const x = fold(a), y = fold(b); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); }
function collides(a: Spec, b: Spec): boolean {
  const fileA = a.record?.remote?.fileId, fileB = b.record?.remote?.fileId;
  return a.item.entryId === b.item.entryId || Boolean(fileA && fileA === fileB) || overlap(a.item.displayPath, b.item.displayPath);
}

describe("transfer queue invariants over random plans", () => {
  it("never overlaps conflicting or barrier work, respects both caps, never overtakes, and returns plan order", async () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = prng(seed);
      const specs = build(random, 5 + Math.floor(random() * 50));
      const records = new Map(specs.flatMap((spec) => spec.record ? [[spec.item.entryId, spec.record] as const] : []));
      const byId = new Map(specs.map((spec) => [spec.item.entryId, spec] as const));
      const index = new Map(specs.map((spec, position) => [spec.item.entryId, position] as const));
      const active = new Set<string>();
      const startOrder: number[] = [];
      let maxActive = 0;

      const results = await runTransferQueue(specs.map((spec) => spec.item), records, limits, async (item) => {
        const me = byId.get(item.entryId)!;
        const mine = index.get(item.entryId)!;
        startOrder.push(mine);
        // Every other running job must be compatible with this one.
        for (const other of active) {
          const o = byId.get(other)!;
          expect(me.eligible && o.eligible, `seed ${seed}: barrier ${item.entryId} overlapped ${other}`).toBe(true);
          expect(collides(me, o), `seed ${seed}: ${item.displayPath} collided with ${o.item.displayPath}`).toBe(false);
        }
        active.add(item.entryId);
        maxActive = Math.max(maxActive, active.size);
        expect(active.size, `seed ${seed}: worker cap`).toBeLessThanOrEqual(limits.workers);
        const weight = [...active].reduce((sum, id) => sum + byId.get(id)!.weight, 0);
        expect(active.size === 1 || weight <= limits.bytes, `seed ${seed}: byte budget ${weight}`).toBe(true);
        for (let yields = Math.floor(random() * 6); yields > 0; yields -= 1) await Promise.resolve();
        if (random() < 0.5) await new Promise<void>((resolve) => setImmediate(resolve));
        active.delete(item.entryId);
        return item.entryId;
      });

      expect(results, `seed ${seed}: result order`).toEqual(specs.map((spec) => spec.item.entryId));
      expect(startOrder, `seed ${seed}: FIFO starts`).toEqual(specs.map((_, position) => position));
      expect(active.size).toBe(0);
      expect(maxActive).toBeLessThanOrEqual(limits.workers);
    }
  }, 120_000);

  it("drains cleanly after a random failure: no job is left running and nothing starts afterwards", async () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const random = prng(seed * 7919);
      const specs = build(random, 8 + Math.floor(random() * 30));
      const records = new Map(specs.flatMap((spec) => spec.record ? [[spec.item.entryId, spec.record] as const] : []));
      const failing = Math.floor(random() * specs.length);
      const active = new Set<string>();
      const started: number[] = [];
      let finishedWork = 0;
      let outcome: unknown = null;
      try {
        await runTransferQueue(specs.map((spec) => spec.item), records, limits, async (item) => {
          const position = specs.findIndex((spec) => spec.item.entryId === item.entryId);
          started.push(position);
          active.add(item.entryId);
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (random() < 0.5) await Promise.resolve();
          active.delete(item.entryId);
          finishedWork += 1;
          if (position === failing) throw new Error(`boom-${position}`);
          return position;
        });
      } catch (error) { outcome = error; }
      const startedWhenSettled = started.length;
      for (let tick = 0; tick < 5; tick += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      expect(active.size, `seed ${seed}: running jobs after rejection`).toBe(0);
      expect(started.length, `seed ${seed}: started after rejection`).toBe(startedWhenSettled);
      expect(finishedWork, `seed ${seed}: every started job ran to completion`).toBe(started.length);
      if (started.includes(failing)) expect((outcome as Error | null)?.message, `seed ${seed}`).toBe(`boom-${failing}`);
      else expect(outcome, `seed ${seed}`).toBeNull();
    }
  }, 120_000);
});
