import { normalizeExcludes } from "../../src/local/selection";
import { NyraNextcloudSyncSettingTab } from "../../src/ui/settings-tab";
import { DEFAULT_SETTINGS } from "../../src/state/settings";
import { ICON_NAMES, createIcon, createLogo } from "../../src/ui/icons";

type Scenario = "healthy" | "syncing" | "attention" | "disconnected" | "worst" | "offline";
const params = new URLSearchParams(location.search);
const scenario = (params.get("scenario") ?? "healthy") as Scenario;
const tab = params.get("tab");
const still = document.createElement("style");
still.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
document.head.appendChild(still);
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
document.body.classList.add(params.get("theme") === "light" ? "theme-light" : "theme-dark");

if (params.get("page") === "icons") {
  const names = ICON_NAMES;
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding:24px;display:grid;grid-template-columns:repeat(6,1fr);gap:18px 12px;font:12px system-ui;color:var(--text-muted);width:760px";
  document.body.appendChild(wrap);
  const logoCell = document.createElement("div");
  logoCell.style.cssText = "grid-column:span 6;display:flex;gap:24px;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--background-modifier-border)";
  for (const size of [20, 32, 48, 96]) logoCell.appendChild(createLogo(size));
  wrap.appendChild(logoCell);
  for (const name of names) {
    const cell = document.createElement("div");
    cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--text-normal)";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;align-items:center";
    for (const size of [14, 16, 24, 40]) row.appendChild(createIcon(name, size));
    cell.append(row, Object.assign(document.createElement("span"), { textContent: name, style: "color:var(--text-muted);font-size:11px" }));
    wrap.appendChild(cell);
  }
(window as unknown as { __ready: boolean }).__ready = true;
  throw new Error("icon sheet rendered");
}

let previewExcludes: string[] = params.get("excluded") ? (params.get("excluded") ?? "").split("|") : [];
type PreviewEntry = { name: string; path: string; isFolder: boolean; size: number | null; onDevice: boolean; onServer: boolean };
function previewTree(many: boolean): Record<string, PreviewEntry[]> {
  const file = (path: string, size: number | null, side: "both" | "device" | "server" = "both"): PreviewEntry => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isFolder: false, size, onDevice: side !== "server", onServer: side !== "device" });
  const folder = (path: string, side: "both" | "device" | "server" = "both"): PreviewEntry => ({ name: path.slice(path.lastIndexOf("/") + 1), path, isFolder: true, size: null, onDevice: side !== "server", onServer: side !== "device" });
  const attachments = Array.from({ length: many ? 460 : 4 }, (_, i) => file(`Attachments/Pasted image 2026${String(1000 + i).padStart(4, "0")}.png`, 120_000 + i * 1313));
  return {
    "": [folder("Attachments"), folder("Daily"), folder("Inbox", "device"), folder("Projects"), folder("Schule"),
      file("Welcome.md", 2_140), file("Notizen zum Quartalsbericht für die Geschäftsführung der Northwind Industries Holdings (final v0).excalidraw.md", 48_300), file("Wunschliste.md", 912, "server")],
    Projects: [folder("Projects/NYRA"), folder("Projects/Ideas"), file("Projects/todo.md", 1_204)],
    "Projects/NYRA": [folder("Projects/NYRA/build"), file("Projects/NYRA/Architecture.md", 18_220), file("Projects/NYRA/Roadmap.md", 6_410), file("Projects/NYRA/board.canvas", 31_900)],
    Schule: [folder("Schule/Mathe"), folder("Schule/Technik", "server"), file("Schule/Stundenplan.pdf", 214_000, "server")],
    Attachments: attachments,
    Daily: [file("Daily/2026-10-21.md", 1_880), file("Daily/2026-10-20.md", 1_430)],
    Inbox: [file("Inbox/Scan 04.pdf", 1_240_000, "device")]
  };
}
const now = Date.now();
const iso = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();
const connected = scenario !== "disconnected";
const worst = scenario === "worst";
const LONG_HOST = "nextcloud-internal-collaboration.northwind-industries-holdings.example.com";

const settings = {
  ...DEFAULT_SETTINGS,
  serverUrl: connected ? (worst ? `https://${LONG_HOST}` : "https://nextcloud.home.example.com") : "",
  remoteRootPath: "Obsidian/Nyra",
  connectionState: connected ? "verified" : "disconnected",
  autoSyncEnabled: true,
  excludePatterns: ["*.tmp", "Private/", ".git/"],
  account: connected ? {
    serverUrl: worst ? `https://${LONG_HOST}` : "https://nextcloud.home.example.com", loginName: "on2me", userId: "on2me", displayName: worst ? "Aleksandra Wiśniewska-Kowalczyk" : "On2me",
    webdavRootUrl: "https://nextcloud.home.example.com/remote.php/dav/files/on2me/", serverVersion: "33.0.9.1", serverVersionString: "33.0.9", verifiedAt: iso(3600)
  } : null,
  credentialBinding: connected ? { serverUrl: worst ? `https://${LONG_HOST}` : "https://nextcloud.home.example.com", loginName: "on2me", secretId: "nyra-nextcloud-00000000000000000000000000000000" } : null
};

const activity = [
  ["uploaded", "Projects/NYRA/Roadmap.md", 8], ["downloaded", "Schule/Mathe/Lineare Funktionen.excalidraw.md", 31], ["merged", "Daily/2026-10-21.md", 95],
  ["folder-created", "Projects/Ideas", 190], ["moved", "Inbox/Scan 04.pdf", 420], ["deleted-on-server", "Archive/old-draft.md", 700],
  ["deleted-here", "Schule/Technik/Entwurf.md", 1500], ["uploaded", "Attachments/Pasted image 20261021.png", 2400]
].map(([kind, path, ago]) => ({ at: iso(ago as number), kind, path }));
if (worst) {
  for (let i = 0; i < 59; i += 1) activity.push({ at: iso(3000 + i * 60), kind: ["uploaded", "downloaded", "merged", "deleted-here"][i % 4], path: `Projects/Kunden/Northwind Industries Holdings/Quartalsberichte 2026/Entwürfe und Überarbeitungen/Bericht ${i + 1} — Zusammenfassung für die Geschäftsführung (final v${i}).excalidraw.md` } as never);
}
if (scenario === "attention" || worst) {
  activity.unshift({ at: iso(20), kind: "held-deletions", path: "", detail: "28 deletion(s) are waiting for your approval" } as never);
  activity.splice(2, 0, { at: iso(40), kind: "error", path: "", detail: "Server unreachable" } as never);
}

const busy = scenario === "syncing";
const plan = {
  summary: { total: 120, noop: scenario === "attention" ? 96 : 120, ready: scenario === "attention" ? 12 : 0, needsVerification: 3, mergeCandidates: 1, blocked: scenario === "attention" ? 2 : 0, destructiveSteps: 28, remoteVerifications: 3 },
  items: scenario === "attention" ? [
    { entryId: "e1", displayPath: worst ? "Projects/Kunden/Northwind Industries Holdings/Quartalsberichte 2026/Entwürfe und Überarbeitungen/Bericht 1 — Zusammenfassung für die Geschäftsführung (final v0).excalidraw.md" : "Projects/NYRA/Roadmap.md", disposition: "ready", classification: "local-only-change", reasons: ["Local content changed since the verified base."], steps: [{ description: "Upload the changed local file." }], localChanged: true },
    { entryId: "e2", displayPath: "Daily/2026-10-21.md", disposition: "blocked", classification: "both-change", reasons: ["Both devices changed the same text region."], steps: [], localChanged: true, remoteChanged: true },
    { entryId: "e3", displayPath: "Schule/Mathe/Kurve.md", disposition: "needs-verification", classification: "remote-changed", reasons: ["Remote ETag changed."], steps: [{ description: "Verify the remote content hash." }], remoteChanged: true }
  ] : []
};
const conflicts = scenario === "attention" || worst ? [{
  entryId: "e2", path: "Daily/2026-10-21.md", classification: "both-change", reasons: ["Both devices changed the same text region."],
  local: { path: "Daily/2026-10-21.md", sha256: "a".repeat(64), size: 412, mtimeMs: now - 600_000 },
  base: { path: "Daily/2026-10-21.md", sha256: "b".repeat(64), size: 380, createdAt: iso(7200) },
  remote: { path: "Daily/2026-10-21.md", sha256: "c".repeat(64), size: 431, mtimeMs: now - 120_000, fileId: "333513", etag: "\"44be84c8ae12\"" }
}] : [];

const owner: any = {
  settings, app: {}, manifest: { version: "0.18.0" },
  stateInitializationError: null, remoteWriteSafetyError: null,
  auth: {
    isLoginActive: () => false, getPreparedBrowserLoginUrl: () => "https://nextcloud.home.example.com/login/v2/flow/abc",
    prepareBrowserLogin: async () => undefined, cancelLogin: () => undefined
  },
  registerInterval: (id: number) => id,
  hasStoredCredentials: () => connected, canVerifyStoredCredentials: () => connected,
  isSyncBusy: () => busy, isRuntimeInitializing: () => false, isExecutionActive: () => busy,
  hasConvergenceErrors: () => false,
  plannerSummary: () => ({ status: "ready", summary: plan.summary, lastError: null }),
  serverHealthSummary: () => connected ? ({ state: scenario === "attention" ? "degraded" : "online", message: scenario === "attention" ? "Waiting for a stable response" : "Reachable", serverVersionString: "33.0.9", nextCheckAt: iso(-45) }) : null,
  autoSyncSummary: () => ({
    enabled: connected, status: busy ? "syncing" : scenario === "attention" ? "attention" : "idle", pendingLocalChanges: 0,
    lastSuccessAt: iso(42), lastRunAt: iso(42), nextRunAt: iso(-30), nextRemotePollAt: iso(-30), lastError: null
  }),
  currentSyncPlan: () => connected ? plan : null,
  executionSummary: () => busy ? ({
    status: "running", activeAction: "upload", activePath: "Attachments/Scan 2026-10-21.pdf", startedAt: iso(14), completedSteps: 3, totalSteps: 8,
    bytesProcessed: 14_800_000, activeTransferBytes: 6_300_000, activeTransferTotalBytes: 14_800_000, lastError: null, mergedFiles: 0
  }) : ({ status: "completed", activeAction: null, activePath: null, startedAt: iso(50), completedSteps: 4, totalSteps: 4, bytesProcessed: 309303, activeTransferBytes: 0, activeTransferTotalBytes: null, lastError: null, mergedFiles: 1 }),
  syncConflictReviews: () => conflicts,
  durableStateSummary: () => connected ? ({ status: "ready", generation: 18, walSequence: 412, files: 128 }) : null,
  convergenceAuditSummary: () => connected ? ({ status: "healthy", errors: 0, warnings: 0, issues: [], verifiedCleanRecords: 126, cleanRecords: 126, generation: 18 }) : null,
  localInventorySummary: () => connected ? ({ status: "ready", trackedFiles: 128, issueCount: 0, readBlocks: [] }) : null,
  remoteInventorySummary: () => connected ? ({ status: "ready", trackedRemoteFiles: 128, issueCount: 0, scanProgress: null }) : null,
  remoteInventoryProgressSummary: () => null,
  pendingDeletions: () => worst ? { total: 1, files: 1, folders: 0, pendingRemoteDeletes: 1, pendingLocalDeletes: 0, sample: ["Projects/Kunden/Northwind Industries Holdings/Quartalsberichte 2026/Entwürfe und Überarbeitungen/Bericht 1 — Zusammenfassung für die Geschäftsführung (final v0).excalidraw.md"], detectedAt: iso(20) } : scenario === "attention" ? { total: 28, files: 24, folders: 4, pendingRemoteDeletes: 24, pendingLocalDeletes: 0, sample: ["Schule/Mathe/Aufgabe 1.md", "Schule/Mathe/Aufgabe 2.md", "Schule/Mathe/Aufgabe 3.md"], detectedAt: iso(20) } : null,
  skippedLargeFiles: () => scenario === "attention" || worst ? { local: ["Videos/Vorlesung 12.mov"], remote: ["Videos/Vorlesung 12.mov", "Backups/vault.zip"], limitMiB: 32 } : { local: [], remote: [], limitMiB: 32 },
  activityEntries: () => connected ? activity : [],
  deviceFileLimitMiB: () => 32,
  remotePollStats: () => ({ skipped: 41, full: 3, fastCheckVerified: true }),
  updateSettings: async (mutator: (s: typeof settings) => void) => { mutator(settings); },
  runAutoSyncNow: async () => ({ executed: false, completedSteps: 0, reviewItems: 0, blockedSteps: 0 }),
  listSyncTree: async (folder: string) => ({ entries: (previewTree(worst)[folder] ?? []).map((entry) => ({ ...entry })), serverReachable: scenario !== "offline" }),
  syncSelectionExcludes: () => previewExcludes,
  setSyncSelection: async (path: string, included: boolean) => {
    previewExcludes = included ? previewExcludes.filter((entry) => entry !== path && !entry.startsWith(`${path}/`)) : normalizeExcludes([...previewExcludes, path]);
    return previewExcludes;
  },
  resetSyncSelection: async () => { previewExcludes = []; },
  approvePendingDeletions: () => true, undoPendingLocalDeletions: async () => 0,
  checkServerHealth: async () => owner.serverHealthSummary(), buildSyncPlan: async () => plan, applyCurrentSyncPlan: async () => ({ completed: 0, mergedFiles: 0 })
};

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const host = document.createElement("div");
host.className = "vertical-tab-content";
const forcedWidth = Number(params.get("w") ?? 0);
if (forcedWidth > 0) { host.style.width = `${forcedWidth}px`; host.style.padding = "16px 0"; }
document.body.appendChild(host);
const settingTab = new NyraNextcloudSyncSettingTab({} as never, owner as never);
if (tab) (settingTab as unknown as { activeTab?: string }).activeTab = tab;
host.appendChild(settingTab.containerEl);
settingTab.display();
{
  const runs = 30;
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) settingTab.display();
  document.body.dataset.renderMs = ((performance.now() - started) / runs).toFixed(2);
  document.body.dataset.nodes = String(host.querySelectorAll("*").length);
}

void (async () => {
for (const path of (params.get("expand") ?? "").split("|").filter(Boolean)) {
  await flush();
  host.querySelector<HTMLElement>(`.nyra-nc-tree__row[data-path="${CSS.escape(path)}"]`)?.click();
}
await flush();
if (params.get("open")) {
  // Open the n-th choice menu so its look can be screenshotted (hover state is forced with ?hover=<option index>).
  const menus = host.querySelectorAll<HTMLDetailsElement>(".nyra-nc-select");
  const menu = menus[Number(params.get("open")) - 1];
  if (menu) {
    menu.open = true;
    const hover = Number(params.get("hover") ?? -1);
    if (hover >= 0) menu.querySelectorAll<HTMLElement>(".nyra-nc-select__option")[hover]?.classList.add("is-hover-preview");
  }
}
(window as unknown as { __ready: boolean }).__ready = true;
})();
