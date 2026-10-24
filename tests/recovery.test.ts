import { describe, expect, it } from "vitest";
import { evaluateDeleteGuard } from "../src/execution/delete-guard";
import type { SyncPlan, SyncPlanItem, SyncPlanStep } from "../src/planner/types";
import { DeletionLedger } from "../src/recovery/deletion-ledger";
import { NextcloudTrash } from "../src/recovery/nextcloud-trash";
import { PersistedList } from "../src/recovery/persisted-list";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/network/http-client";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

function step(kind: SyncPlanStep["kind"]): SyncPlanStep {
  return { kind, sourcePath: "x", targetPath: null, destructive: kind.startsWith("delete"), requiresFreshRemoteEtag: false, description: kind };
}
function plan(kinds: Array<SyncPlanStep["kind"]>, disposition: SyncPlanItem["disposition"] = "ready"): SyncPlan {
  return {
    items: kinds.map((kind, index) => ({ entryId: `e${index}`, displayPath: `file-${index}.md`, disposition, steps: [step(kind)] } as unknown as SyncPlanItem))
  } as unknown as SyncPlan;
}
const deletes = (count: number, kind: SyncPlanStep["kind"] = "delete-remote") => plan(Array.from({ length: count }, () => kind));

describe("mass-deletion guard", () => {
  it("lets ordinary deletions through", () => {
    const decision = evaluateDeleteGuard(deletes(3), { threshold: 20, trackedFiles: 1000, approvedItems: 0 });
    expect(decision.held).toBe(false);
    expect(decision.remoteDeletes).toBe(3);
  });

  it("holds more deletions than the threshold, counting both directions, and lists a sample", () => {
    const decision = evaluateDeleteGuard(plan([...Array(15).fill("delete-remote"), ...Array(10).fill("delete-local")]), { threshold: 20, trackedFiles: 1000, approvedItems: 0 });
    expect(decision).toMatchObject({ held: true, total: 25, localDeletes: 10, remoteDeletes: 15 });
    expect(decision.sample).toHaveLength(10);
  });

  it("holds deleting most of a small vault even below the absolute threshold", () => {
    expect(evaluateDeleteGuard(deletes(6), { threshold: 20, trackedFiles: 8, approvedItems: 0 }).held).toBe(true);
    expect(evaluateDeleteGuard(deletes(4), { threshold: 20, trackedFiles: 4, approvedItems: 0 }).held).toBe(false);
  });

  it("honours approvals, a disabled threshold and ignores blocked or no-op items", () => {
    expect(evaluateDeleteGuard(deletes(30), { threshold: 20, trackedFiles: 1000, approvedItems: 30 }).held).toBe(false);
    expect(evaluateDeleteGuard(deletes(30), { threshold: 20, trackedFiles: 1000, approvedItems: 29 }).held).toBe(true);
    expect(evaluateDeleteGuard(deletes(300), { threshold: 0, trackedFiles: 1000, approvedItems: 0 }).held).toBe(false);
    expect(evaluateDeleteGuard(plan(Array(40).fill("delete-remote"), "blocked"), { threshold: 20, trackedFiles: 1000, approvedItems: 0 }).total).toBe(0);
  });
});

describe("deletion ledger", () => {
  const hash = "a".repeat(64);
  it("persists entries, returns newest first and survives a restart", async () => {
    const adapter = new MemoryVaultAdapter();
    let now = Date.parse("2026-10-21T00:00:00Z");
    const ledger = new DeletionLedger(adapter, "ledger.json", () => now);
    await ledger.record([
      { path: "a.md", blobHash: hash, size: 1, deletedAt: "2026-10-20T00:00:00Z", removed: "remote" },
      { path: "b.md", blobHash: hash, size: 2, deletedAt: "2026-10-20T01:00:00Z", removed: "local" }
    ]);
    const reopened = new DeletionLedger(adapter, "ledger.json", () => now);
    expect((await reopened.recent()).map((entry) => entry.path)).toEqual(["b.md", "a.md"]);
    now = Date.parse("2027-03-01T00:00:00Z"); // older than 90 days
    expect(await reopened.recent()).toEqual([]);
  });

  it("forgets a restored entry and ignores damaged storage", async () => {
    const adapter = new MemoryVaultAdapter();
    const ledger = new DeletionLedger(adapter, "ledger.json", () => Date.parse("2026-10-21T00:00:00Z"));
    const entry = { path: "a.md", blobHash: hash, size: 1, deletedAt: "2026-10-20T00:00:00Z", removed: "remote" as const };
    await ledger.record([entry]);
    await ledger.forget(entry);
    expect(await ledger.recent()).toEqual([]);
    await adapter.write("bad.json", "{broken");
    expect(await new DeletionLedger(adapter, "bad.json").recent()).toEqual([]);
    await adapter.write("mixed.json", JSON.stringify({ version: 1, entries: [{ nonsense: true }, { ...entry, blobHash: "short" }, entry] }));
    expect(await new DeletionLedger(adapter, "mixed.json", () => Date.parse("2026-10-21T00:00:00Z")).recent()).toHaveLength(1);
  });
});

describe("bounded persisted list", () => {
  it("keeps only the newest entries", async () => {
    const adapter = new MemoryVaultAdapter();
    const list = new PersistedList<number>(adapter, "n.json", { maxEntries: 3, parse: (value) => typeof value === "number" ? value : null });
    await list.append([1, 2]);
    await list.append([3, 4, 5]);
    expect(await new PersistedList<number>(adapter, "n.json", { maxEntries: 3, parse: (value) => typeof value === "number" ? value : null }).load()).toEqual([3, 4, 5]);
  });
});

describe("Nextcloud trash bin client", () => {
  const xml = (rows: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${rows}</d:multistatus>`;
  const row = (name: string, original: string, time: number, folder = false) =>
    `<d:response><d:href>/remote.php/dav/trashbin/u/trash/${encodeURIComponent(name)}${folder ? "/" : ""}</d:href><d:propstat><d:prop><nc:trashbin-filename>${name}</nc:trashbin-filename><nc:trashbin-original-location>${original}</nc:trashbin-original-location><nc:trashbin-deletion-time>${time}</nc:trashbin-deletion-time>${folder ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/><d:getcontentlength>5</d:getcontentlength>"}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  function transport(handler: (request: HttpRequest) => { status: number; text?: string }): { http: HttpTransport; requests: HttpRequest[] } {
    const requests: HttpRequest[] = [];
    return {
      requests,
      http: { async request(request): Promise<HttpResponse> {
        requests.push(request);
        const { status, text = "" } = handler(request);
        return { status, headers: {}, text, arrayBuffer: new ArrayBuffer(0), json: () => ({}) };
      } }
    };
  }

  it("lists only items from the synchronized folder, newest first, without internal staging data", async () => {
    const { http } = transport(() => ({ status: 207, text: xml(
      row("collection", "", 0, true).replace("<nc:trashbin-original-location></nc:trashbin-original-location>", "") +
      row("old.md.d100", "Obsidian/Vault/old.md", 100) +
      row("new.md.d200", "Obsidian/Vault/Sub/new.md", 200) +
      row("other.md.d300", "Elsewhere/other.md", 300) +
      row("probe.d400", "Obsidian/Vault/.nyra-nextcloud-sync-runtime/probe.txt", 400) +
      row("Vault2.d500", "Obsidian/Vault2/x.md", 500)
    ) }));
    const trash = new NextcloudTrash(http, "https://cloud.example", "u", "Basic x");
    const items = await trash.list("Obsidian/Vault");
    expect(items.map((item) => item.originalLocation)).toEqual(["Obsidian/Vault/Sub/new.md", "Obsidian/Vault/old.md"]);
    expect(items[0]?.trashName).toBe("new.md.d200");
  });

  it("restores with a MOVE into the restore collection and surfaces conflicts", async () => {
    const { http, requests } = transport((request) => request.method === "MOVE" && request.url.includes("busy") ? { status: 412 } : { status: 201 });
    const trash = new NextcloudTrash(http, "https://cloud.example", "u", "Basic x");
    await trash.restore({ trashName: "a b.md.d1", originalLocation: "x/a b.md", isFolder: false, size: 1, deletedAt: "2026-01-01T00:00:00Z" });
    expect(requests[0]?.method).toBe("MOVE");
    expect(requests[0]?.url).toBe("https://cloud.example/remote.php/dav/trashbin/u/trash/a%20b.md.d1");
    expect(requests[0]?.headers?.Destination).toBe("https://cloud.example/remote.php/dav/trashbin/u/restore/a%20b.md.d1");
    await expect(trash.restore({ trashName: "busy.d1", originalLocation: "x/busy", isFolder: false, size: 1, deletedAt: "2026-01-01T00:00:00Z" })).rejects.toThrow(/already exists/);
  });
});

describe("deletion hold", () => {
  it("holds, approves for a limited time and consumes the approval", async () => {
    const { DeletionHold } = await import("../src/execution/deletion-hold");
    let now = 1_000_000;
    const hold = new DeletionHold(() => now);
    const big = deletes(30);
    const first = hold.evaluate(big, 20, 1000);
    expect(first).toMatchObject({ newlyHeld: true });
    expect(hold.summary()).toMatchObject({ total: 30, files: 30, folders: 0, pendingRemoteDeletes: 30 });
    expect(hold.evaluate(big, 20, 1000).newlyHeld).toBe(false);
    expect(hold.folderLimit(20)).toBe(20);

    expect(hold.approve()).toBe(true);
    expect(hold.evaluate(big, 20, 1000).decision.held).toBe(false);
    expect(hold.folderLimit(20)).toBeUndefined();
    expect(hold.evaluate(deletes(45), 20, 1000).decision.held).toBe(true); // larger than what was approved
    hold.consumeApproval();
    expect(hold.summary()).toBeNull();

    expect(hold.evaluate(big, 20, 1000).decision.held).toBe(true);
    hold.approve();
    now += 16 * 60_000; // approval expired
    expect(hold.evaluate(big, 20, 1000).decision.held).toBe(true);
  });

  it("counts held folder removals and reports nothing when idle", async () => {
    const { DeletionHold } = await import("../src/execution/deletion-hold");
    const hold = new DeletionHold();
    expect(hold.summary()).toBeNull();
    expect(hold.approve()).toBe(false);
    hold.setHeldFolders(7);
    expect(hold.summary()).toMatchObject({ total: 7, files: 0, folders: 7 });
    hold.setHeldFolders(0);
    expect(hold.summary()).toBeNull();
  });
});

describe("recovery service", () => {
  it("restores retained bytes, avoids overwriting and records the activity", async () => {
    const { RecoveryService } = await import("../src/recovery/recovery-service");
    const { ActivityLog } = await import("../src/activity/activity-log");
    const adapter = new MemoryVaultAdapter();
    const ledger = new DeletionLedger(adapter, "l.json", () => Date.parse("2026-10-21T00:00:00Z"));
    const activity = new ActivityLog(adapter, "a.json", () => new Date("2026-10-21T00:00:00Z"));
    const written = new Map<string, string>();
    const service = new RecoveryService({
      ledger, activity,
      getBlob: async () => new TextEncoder().encode("old content").buffer as ArrayBuffer,
      exists: async (path) => written.has(path) || path === "Taken.md",
      createFile: async (path, bytes) => { written.set(path, new TextDecoder().decode(bytes)); },
      isInScope: (path) => !path.startsWith("Private/"),
      trash: () => null, remoteRoot: () => "Obsidian",
      now: () => new Date("2026-10-21T00:00:00Z")
    });
    const entry = { path: "Folder/Gone.md", blobHash: "a".repeat(64), size: 11, deletedAt: "2026-10-20T00:00:00Z", removed: "remote" as const };
    await ledger.record([entry]);
    expect(await service.restoreDeleted(entry)).toBe("Folder/Gone.md");
    expect(written.get("Folder/Gone.md")).toBe("old content");
    expect(await ledger.recent()).toEqual([]);
    expect(activity.recent()[0]).toMatchObject({ kind: "downloaded", path: "Folder/Gone.md" });

    expect(await service.restoreDeleted({ ...entry, path: "Taken.md" })).toBe("Taken (restored 2026-10-21).md");
    await expect(service.restoreFromBase("Taken.md", entry.blobHash, false)).rejects.toThrow(/already exists/);
    await expect(service.restoreFromBase("Private/x.md", entry.blobHash, true)).rejects.toThrow(/outside the current sync scope/);
    await expect(service.restoreTrash({ trashName: "x", originalLocation: "x", isFolder: false, size: 1, deletedAt: "2026-10-20T00:00:00Z" })).rejects.toThrow(/Connect/);
    expect(await service.listTrash()).toEqual([]);
  });
});

describe("probe leftovers in the trash bin", () => {
  it("purges only the plugin's own probe files below the sync root", async () => {
    const row = (name: string, original: string, time: number) =>
      `<d:response><d:href>/remote.php/dav/trashbin/u/trash/${encodeURIComponent(name)}.d${time}</d:href><d:propstat><d:prop><nc:trashbin-filename>${name}</nc:trashbin-filename><nc:trashbin-original-location>${original}</nc:trashbin-original-location><nc:trashbin-deletion-time>${time}</nc:trashbin-deletion-time><d:resourcetype/><d:getcontentlength>3</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const listing = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns">${[
      row("etag-probe_ab12.txt.moved", "Obsidian/Vault/.nyra-nextcloud-sync-runtime/etag-probe_ab12.txt.moved", 1),
      row("probe.txt", "Obsidian/Vault/.nyra-nextcloud-sync-runtime/rootetag-ff00/a/probe.txt", 2),
      row("notes.md", "Obsidian/Vault/.nyra-nextcloud-sync-runtime/notes.md", 3),
      row("etag-probe_zz.txt", "Other/.nyra-nextcloud-sync-runtime/etag-probe_zz.txt", 4),
      row("etag-probe_root.txt.moved", ".nyra-nextcloud-sync-runtime/etag-probe_root.txt.moved", 6),
      row("etag-probe_user.md", "Obsidian/Vault/etag-probe_user.md", 5)
    ].join("")}</d:multistatus>`;
    const deleted: string[] = [];
    const http: HttpTransport = { async request(request): Promise<HttpResponse> {
      if (request.method === "DELETE") { deleted.push(request.url); return { status: 204, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0), json: () => ({}) }; }
      return { status: 207, headers: {}, text: listing, arrayBuffer: new ArrayBuffer(0), json: () => ({}) };
    } };
    const trash = new NextcloudTrash(http, "https://cloud.example", "u", "Basic x");
    expect(await trash.purgeProbeLeftovers("Obsidian/Vault")).toBe(3);
    expect(deleted.map((url) => decodeURIComponent(url.split("/").pop() ?? ""))).toEqual(["etag-probe_ab12.txt.moved.d1", "probe.txt.d2", "etag-probe_root.txt.moved.d6"]);
  });
});

describe("deletion hold approval lifetime", () => {
  it("drops a lingering approval once the approved deletions are gone", async () => {
    const { DeletionHold } = await import("../src/execution/deletion-hold");
    const hold = new DeletionHold(() => 5_000);
    hold.evaluate(deletes(30), 20, 1000);
    hold.approve();
    expect(hold.hasApproval()).toBe(true);
    hold.evaluate(deletes(0), 20, 1000);
    expect(hold.hasApproval()).toBe(false);
    hold.setHeldFolders(5);
    hold.approve();
    hold.evaluate(deletes(0), 20, 1000); // folder removals are still pending: keep the approval
    expect(hold.hasApproval()).toBe(true);
  });
});
