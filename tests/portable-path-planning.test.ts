import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { SyncPlanner } from "../src/planner/planner";
import { DurableStateStore } from "../src/state/durable/store";
import { MemoryStateBackend } from "./helpers/memory-backend";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
async function fixture(localPaths: string[], remotePaths: string[]) {
  const store = await DurableStateStore.open(new MemoryStateBackend(), logger);
  await store.transact("portable-path-test", (tx) => {
    for (const [index, path] of localPaths.entries()) tx.putFile({
      entryId: `local-entry-${index}`, path, baseline: null,
      local: { path, contentHash: "a".repeat(64), size: 1, mtimeMs: 1 }, remote: null, status: "local-dirty"
    });
    for (const [index, path] of remotePaths.entries()) tx.putFile({
      entryId: `remote-entry-${index}`, path, baseline: null, local: null,
      remote: { path, contentHash: null, reportedSha256: null, fileId: String(index + 1), etag: '"etag"', size: 1, mtimeMs: 1 }, status: "remote-dirty"
    });
  });
  return store;
}

describe("Portable planner path ownership", () => {
  it("blocks different identities separated only by letter case or Unicode composition", async () => {
    for (const [local, remote] of [["Note.md", "note.md"], ["Café.md", "Cafe\u0301.md"]]) {
      const store = await fixture([local!], [remote!]);
      const plan = await new SyncPlanner().build(store.getState());
      expect(plan.summary.blocked).toBe(2);
      expect(plan.items.every((item) => item.classification === "path-identity-collision")).toBe(true);
      expect(plan.items.every((item) => item.steps.every((step) => step.kind === "manual-resolution"))).toBe(true);
      await store.close();
    }
  });

  it("blocks same-side case aliases before attempting transfers to another filesystem", async () => {
    const store = await fixture([], ["Note.md", "note.md"]);
    expect((await new SyncPlanner().build(store.getState())).summary.blocked).toBe(2);
    await store.close();
  });

  it("blocks file-versus-directory collisions while retaining unrelated executable work", async () => {
    const store = await fixture(["Notes", "unrelated.md"], ["notes/nested/file.md"]);
    const plan = await new SyncPlanner().build(store.getState());
    expect(plan.summary.blocked).toBe(2);
    expect(plan.summary.ready).toBe(1);
    expect(plan.items.find((item) => item.displayPath === "unrelated.md")?.classification).toBe("local-create");
    await store.close();
  });

  it("does not include excluded replicas in collision ownership", async () => {
    const store = await fixture(["Note.md"], ["note.md"]);
    const plan = await new SyncPlanner().build(store.getState(), (path) => path !== "note.md");
    expect(plan.summary.total).toBe(1); expect(plan.summary.ready).toBe(1); await store.close();
  });

  it("orders plan paths by stable code units independently of insertion order", async () => {
    const store = await fixture(["ä.md", "z.md", "A.md"], []);
    const state = store.getState(); const planner = new SyncPlanner();
    const first = await planner.build(state);
    state.files = Object.fromEntries(Object.entries(state.files).reverse());
    expect(first.items.map((item) => item.displayPath)).toEqual(["A.md", "z.md", "ä.md"]);
    expect((await planner.build(state)).fingerprint).toBe(first.fingerprint);
    await store.close();
  });
});
