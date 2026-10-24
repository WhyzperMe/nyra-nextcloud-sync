import { describe, expect, it } from "vitest";
import { assessBootstrapPlan } from "../src/bootstrap/assessment";
import { LocalPathPolicy } from "../src/local/path-policy";
import { SyncPlanner } from "../src/planner/planner";
import { createEmptyState, type FileReplicaRecord } from "../src/state/durable/model";
import { normalizeSettings } from "../src/state/settings";

function add(state: ReturnType<typeof createEmptyState>, record: FileReplicaRecord): void {
  state.files[record.entryId] = record;
  if (record.local) state.pathIndex[record.local.path] = record.entryId;
  if (record.remote) {
    state.remotePathIndex[record.remote.path] = record.entryId;
    if (record.remote.fileId) state.remoteFileIdIndex[record.remote.fileId] = record.entryId;
  }
}

function localOnly(path = "Notes/A.md"): FileReplicaRecord {
  return {
    entryId: "file-local",
    path,
    generation: "0",
    baseline: null,
    local: { path, contentHash: "a".repeat(64), size: 1, mtimeMs: 1 },
    remote: null,
    status: "local-dirty"
  };
}

function remoteOnly(path = "Notes/A.md"): FileReplicaRecord {
  return {
    entryId: "file-remote",
    path,
    generation: "0",
    baseline: null,
    local: null,
    remote: { path, contentHash: null, reportedSha256: null, etag: '"etag-1"', fileId: "42", size: 1, mtimeMs: 1 },
    status: "remote-dirty"
  };
}

describe("Cross-device bootstrap", () => {
  it("permits publish only for a local-only vault and empty remote scope", async () => {
    const state = createEmptyState("store-stage10-push");
    add(state, localOnly());
    const plan = await new SyncPlanner().build(state);
    const assessment = assessBootstrapPlan(plan, 1, 0);
    expect(assessment.canPublish).toBe(true);
    expect(assessment.canDownload).toBe(false);
    expect(plan.items[0]?.steps.map((step) => step.kind)).toEqual(["upload-create", "establish-baseline"]);
  });

  it("permits download only for an empty device and remote-only vault", async () => {
    const state = createEmptyState("store-stage10-pull");
    add(state, remoteOnly());
    const plan = await new SyncPlanner().build(state);
    const assessment = assessBootstrapPlan(plan, 0, 1);
    expect(assessment.canDownload).toBe(true);
    expect(assessment.canPublish).toBe(false);
    expect(plan.items[0]?.steps.map((step) => step.kind)).toEqual(["download-create", "establish-baseline"]);
  });

  it("refuses first-link shortcuts once both sides contain sync-visible data", async () => {
    const state = createEmptyState("store-stage10-both");
    const local = localOnly("Notes/A.md");
    const remote = remoteOnly("Notes/B.md");
    remote.entryId = "file-remote-b";
    add(state, local);
    add(state, remote);
    const plan = await new SyncPlanner().build(state);
    const assessment = assessBootstrapPlan(plan, 1, 1);
    expect(assessment.canPublish).toBe(false);
    expect(assessment.canDownload).toBe(false);
    expect(assessment.publishReason).toMatch(/already contains/i);
    expect(assessment.downloadReason).toMatch(/already contains/i);
  });
});

describe("Mobile-friendly vault scope", () => {
  it("keeps .obsidian local by default for a new install", () => {
    const settings = normalizeSettings(null);
    expect(settings.syncObsidianConfig).toBe(false);
  });

  it("preserves all-config behavior during migration", () => {
    const settings = normalizeSettings({ schemaVersion: 5, remoteRootPath: "Obsidian", connectionState: "disconnected" });
    expect(settings.syncObsidianConfig).toBe(true);
  });

  it("always excludes device workspace and the sync plugin itself", () => {
    let syncConfig = false;
    const policy = new LocalPathPolicy({
      reservedRoots: [".trash", ".obsidian/plugins/nyra-nextcloud-sync"],
      reservedFiles: [".obsidian/workspace.json", ".obsidian/workspace-mobile.json"],
      configDir: ".obsidian",
      syncObsidianConfig: () => syncConfig
    });
    expect(policy.isIncluded("Notes/A.md")).toBe(true);
    expect(policy.isIncluded(".obsidian/app.json")).toBe(false);
    expect(policy.isIncluded(".obsidian/plugins/nyra-nextcloud-sync/main.js")).toBe(false);
    expect(policy.isIncluded("Nyra/.obsidian/plugins/nyra-nextcloud-sync/state-v2/wal/0001.json")).toBe(false);
    expect(policy.isIncluded("Nyra/.obsidian/appearance.json")).toBe(false);
    syncConfig = true;
    expect(policy.isIncluded(".obsidian/app.json")).toBe(true);
    expect(policy.isIncluded("Nyra/.obsidian/appearance.json")).toBe(true);
    expect(policy.isIncluded(".obsidian/workspace.json")).toBe(false);
    expect(policy.isIncluded(".obsidian/workspace-mobile.json")).toBe(false);
    expect(policy.isIncluded(".obsidian/plugins/nyra-nextcloud-sync/main.js")).toBe(false);
    expect(policy.isIncluded("Nyra/.obsidian/workspace.json")).toBe(false);
    expect(policy.isIncluded("Nyra/.obsidian/plugins/nyra-nextcloud-sync/state-v2/wal/0001.json")).toBe(false);
  });

  it("planner leaves fully out-of-scope config records dormant", async () => {
    const state = createEmptyState("store-stage10-scope");
    add(state, localOnly(".obsidian/app.json"));
    add(state, { ...localOnly("Notes/A.md"), entryId: "file-note", path: "Notes/A.md", local: { path: "Notes/A.md", contentHash: "b".repeat(64), size: 1, mtimeMs: 1 } });
    const plan = await new SyncPlanner().build(state, (path) => !path.startsWith(".obsidian/") && path !== ".obsidian");
    expect(plan.items.length).toBe(1);
    expect(plan.items[0]?.displayPath).toBe("Notes/A.md");
  });
});
