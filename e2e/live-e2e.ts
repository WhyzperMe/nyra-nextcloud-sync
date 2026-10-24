import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Device } from "./device";

/**
 * Live end-to-end run of the real plugin on two real directories against a real
 * Nextcloud. Opt-in: needs NYRA_E2E_SERVER, NYRA_E2E_USER, NYRA_E2E_APP_PASSWORD
 * and NYRA_E2E_PARENT (an existing remote folder that may be written to).
 */
const env = (name: string): string => { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; };
const SERVER = env("NYRA_E2E_SERVER").replace(/\/+$/, "");
const USER = env("NYRA_E2E_USER");
const PASSWORD = env("NYRA_E2E_APP_PASSWORD");
const PARENT = env("NYRA_E2E_PARENT").replace(/^\/+|\/+$/g, "");
const RUN = `e2e-${Date.now().toString(36)}`;
const REMOTE_ROOT = `${PARENT}/${RUN}`;
const DAV = `${SERVER}/remote.php/dav/files/${encodeURIComponent(USER)}`;
const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "manifest.json"), "utf8"));

const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");
async function dav(method: string, p: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}): Promise<Response> {
  const request: RequestInit = { method, headers: { Authorization: AUTH, ...init.headers } };
  if (init.body !== undefined) request.body = init.body as BodyInit;
  return await fetch(`${DAV}/${enc(p)}`, request);
}
/** Independent remote tree listing (files with sha256, and folders), relative to the test root. */
async function remoteTree(): Promise<{ files: Map<string, string>; folders: Set<string> }> {
  const files = new Map<string, string>(); const folders = new Set<string>();
  const queue = [""];
  while (queue.length) {
    const dir = queue.pop()!;
    const res = await dav("PROPFIND", `${REMOTE_ROOT}${dir ? `/${dir}` : ""}`, { headers: { Depth: "1" } });
    if (res.status === 404) continue;
    const xml = await res.text();
    for (const block of xml.split("<d:response>").slice(1)) {
      const href = decodeURIComponent(/<d:href>([^<]*)<\/d:href>/.exec(block)![1]!);
      const rel = href.replace(new RegExp(`^.*?/remote\\.php/dav/files/[^/]+/${REMOTE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "").replace(/\/$/, "");
      if (rel === "" || rel === dir || rel.split("/").includes(".nyra-nextcloud-sync-runtime")) continue; // plugin staging area
      if (block.includes("<d:collection/>")) { folders.add(rel); queue.push(rel); }
      else {
        const body = Buffer.from(await (await dav("GET", `${REMOTE_ROOT}/${rel}`)).arrayBuffer());
        files.set(rel, createHash("sha256").update(body).digest("hex"));
      }
    }
  }
  return { files, folders };
}
function localTree(d: Device): { files: Map<string, string>; folders: Set<string> } {
  const { files, folders } = d.walk("");
  return { files: new Map(files.map((f) => [f, createHash("sha256").update(d.read(f)).digest("hex")])), folders: new Set(folders) };
}
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 60_000, intervalMs = 750): Promise<number> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try { if (await condition()) return Date.now() - started; } catch (error) { lastError = error; }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}${lastError ? ` (${String(lastError)})` : ""}\n${diagnostics()}`);
}
function fmt(t: { files: Map<string, string>; folders: Set<string> }): string {
  return `files=[${[...t.files.keys()].sort().join(", ")}] folders=[${[...t.folders].sort().join(", ")}]`;
}
function sameTree(a: { files: Map<string, string>; folders: Set<string> }, b: { files: Map<string, string>; folders: Set<string> }): boolean {
  if (a.files.size !== b.files.size || a.folders.size !== b.folders.size) return false;
  for (const [k, v] of a.files) if (b.files.get(k) !== v) return false;
  for (const f of a.folders) if (!b.folders.has(f)) return false;
  return true;
}

const devices: Device[] = [];
function diagnostics(): string {
  return devices.map((d) => `${d.name}: autosync=${JSON.stringify(d.plugin?.autoSyncSummary?.())} execution=${JSON.stringify(d.plugin?.executionSummary?.())} safety=${d.plugin?.remoteWriteSafetyError ?? "-"}`).join("\n");
}

async function configure(device: Device, mutator: (settings: any) => void): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await device.plugin.updateSettings(mutator); return; }
    catch (error) {
      if (!String(error).includes("while synchronization is active")) throw error;
      await sleep(500);
    }
  }
  throw new Error("Settings stayed locked by a running sync.");
}
async function remoteText(p: string): Promise<string | null> {
  const res = await dav("GET", `${REMOTE_ROOT}/${p}`);
  return res.status === 200 ? await res.text() : null;
}
const results: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (process.env.NYRA_E2E_ONLY && !name.startsWith("start ") && !name.includes(process.env.NYRA_E2E_ONLY)) return; // run one self-contained scenario while developing
  const started = Date.now();
  process.stdout.write(`• ${name} … `);
  try { await fn(); const ms = Date.now() - started; results.push(`${name} (${(ms / 1000).toFixed(1)}s)`); console.log(`ok (${(ms / 1000).toFixed(1)}s)`); }
  catch (error) { console.log("FAILED"); throw error; }
}

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-e2e-"));
  const A = new Device("desktop", base, manifest, { mobile: false });
  const B = new Device("ipad", base, manifest, { mobile: true });
  devices.push(A, B);
  let exitCode = 0;
  try {
    for (const d of [A, B]) d.seedAccount({ serverUrl: SERVER, userId: USER, appPassword: PASSWORD, remoteRootPath: REMOTE_ROOT });
    let prefix = "";
    for (const segment of PARENT.split("/")) { prefix = prefix ? `${prefix}/${segment}` : segment; await dav("MKCOL", prefix); } // 201 or 405 (exists)
    const created = await dav("MKCOL", REMOTE_ROOT);
    if (created.status !== 201) throw new Error(`Could not create remote test root (${created.status}).`);

    await step("start desktop and mobile devices", async () => { await A.start(); await B.start(); });

    const big = randomBytes(300 * 1024);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(2048)]);
    await step("create notes, nested folders, unicode/special names, binary, empty file and empty folder on desktop", async () => {
      await A.write("Welcome.md", "# Welcome\nline one\nline two\nline three\n");
      await A.write("Folder One/Sub Folder/Note ä ö ü 📝 #1 %20.md", "unicode ✓\n");
      await A.write("Folder One/image.png", png);
      await A.write("Attachments/big.bin", big);
      await A.write("empty-file.txt", "");
      await A.mkdir("Empty Folder/Nested Empty");
      await A.mkdir("Projects/Ideas");
    });
    await step("desktop auto-sync pushes everything to Nextcloud without manual action", async () => {
      try { await until("remote equals desktop", async () => sameTree(await remoteTree(), localTree(A)), 60_000); }
      catch (error) { throw new Error(`${String(error).split("\n")[0]}\n remote: ${fmt(await remoteTree())}\n desktop: ${fmt(localTree(A))}`); }
    });
    const afterCreate = await remoteTree();
    if (!afterCreate.folders.has("Empty Folder/Nested Empty") || !afterCreate.folders.has("Projects/Ideas")) throw new Error(`Empty folders missing on server: ${fmt(afterCreate)}`);

    await step("iPad pulls the whole vault, including empty folders", async () => {
      await B.runSyncNow();
      await until("ipad equals remote", async () => sameTree(localTree(B), await remoteTree()), 60_000);
    });

    await step("edit on iPad reaches desktop via automatic polling", async () => {
      await B.write("Welcome.md", "# Welcome\nline one EDITED ON IPAD\nline two\nline three\n");
      await until("desktop has iPad edit", () => A.read("Welcome.md").toString().includes("EDITED ON IPAD"), 150_000, 1500);
    });

    await step("non-overlapping edits on both devices merge safely", async () => {
      await A.write("Welcome.md", A.read("Welcome.md").toString().replace("line three", "line three EDIT-A"));
      await B.write("Welcome.md", B.read("Welcome.md").toString().replace("# Welcome", "# Welcome EDIT-B"));
      await until("remote merged", async () => {
        const body = Buffer.from(await (await dav("GET", `${REMOTE_ROOT}/Welcome.md`)).arrayBuffer()).toString();
        return body.includes("EDIT-A") && body.includes("EDIT-B");
      }, 120_000, 1500);
      await A.runSyncNow(); await B.runSyncNow();
      await until("devices converge", () => sha(A.read("Welcome.md")) === sha(B.read("Welcome.md")) && A.read("Welcome.md").toString().includes("EDIT-A") && A.read("Welcome.md").toString().includes("EDIT-B"), 90_000);
    });

    await step("deleting a folder with content on desktop removes it everywhere and it never returns", async () => {
      await A.removeRecursive("Folder One");
      await until("remote lost Folder One", async () => { const t = await remoteTree(); return ![...t.files.keys(), ...t.folders].some((p) => p === "Folder One" || p.startsWith("Folder One/")); }, 90_000);
      await B.runSyncNow();
      await until("ipad lost Folder One", () => !B.exists("Folder One"), 60_000);
      for (let i = 0; i < 3; i++) { await A.runSyncNow(); await B.runSyncNow(); await sleep(1500); }
      if (A.exists("Folder One") || B.exists("Folder One")) throw new Error("Deleted folder reappeared locally.");
      const t = await remoteTree();
      if ([...t.files.keys(), ...t.folders].some((p) => p.startsWith("Folder One"))) throw new Error(`Deleted folder reappeared on server: ${fmt(t)}`);
    });

    await step("deleting an empty folder tree on the iPad propagates to server and desktop", async () => {
      await B.removeRecursive("Empty Folder");
      await until("remote lost Empty Folder", async () => !(await remoteTree()).folders.has("Empty Folder"), 90_000);
      await A.runSyncNow();
      await until("desktop lost Empty Folder", () => !A.exists("Empty Folder"), 60_000);
    });

    await step("a single deleted file propagates", async () => {
      await A.removeRecursive("empty-file.txt");
      await until("remote lost file", async () => !(await remoteTree()).files.has("empty-file.txt"), 90_000);
      await B.runSyncNow();
      await until("ipad lost file", () => !B.exists("empty-file.txt"), 60_000);
    });

    await step("renaming a folder with content moves it on server and iPad", async () => {
      await A.rename("Attachments", "Media");
      await until("remote renamed", async () => { const t = await remoteTree(); return t.files.has("Media/big.bin") && !t.files.has("Attachments/big.bin"); }, 90_000);
      await B.runSyncNow();
      await until("ipad renamed", () => B.exists("Media/big.bin") && !B.exists("Attachments"), 60_000);
      await until("remote lost old folder", async () => !(await remoteTree()).folders.has("Attachments"), 60_000);
    });

    const huge = randomBytes(24 * 1024 * 1024);
    await step("large file (24 MiB, chunked upload / ranged download) syncs byte-exact", async () => {
      await A.write("Media/huge.bin", huge);
      await until("remote has huge", async () => (await remoteTree()).files.get("Media/huge.bin") === sha(huge), 240_000, 2000);
      await B.runSyncNow();
      await until("ipad has huge", () => B.exists("Media/huge.bin") && sha(B.read("Media/huge.bin")) === sha(huge), 240_000, 2000);
    });

    await step("exclusion patterns keep matching files and folders off the server, and lifting them syncs them", async () => {
      await configure(A, (settings) => { settings.excludePatterns = ["*.secret", "Private/"]; });
      await A.write("visible.md", "public\n");
      await A.write("token.secret", "hidden\n");
      await A.write("Private/diary.md", "hidden too\n");
      await until("visible.md uploaded", async () => (await remoteTree()).files.has("visible.md"), 90_000);
      await sleep(4000);
      let tree = await remoteTree();
      if (tree.files.has("token.secret") || tree.files.has("Private/diary.md") || tree.folders.has("Private")) throw new Error(`Excluded items reached the server: ${fmt(tree)}`);
      await configure(A, (settings) => { settings.excludePatterns = []; });
      await A.runSyncNow();
      await until("excluded items upload after lifting the rules", async () => { tree = await remoteTree(); return tree.files.has("token.secret") && tree.files.has("Private/diary.md"); }, 90_000);
      await B.runSyncNow();
      await until("ipad received them", () => B.exists("token.secret") && B.exists("Private/diary.md"), 60_000);
    });

    await step("pausing auto-sync stops background sync but Sync now still works", async () => {
      await configure(A, (settings) => { settings.syncPaused = true; });
      await A.write("paused.md", "written while paused\n");
      await sleep(6000);
      if ((await remoteTree()).files.has("paused.md")) throw new Error("Paused auto-sync uploaded a file.");
      await A.runSyncNow();
      await until("manual sync uploaded", async () => (await remoteTree()).files.has("paused.md"), 60_000);
      await configure(A, (settings) => { settings.syncPaused = false; });
    });

    await step("file picker: unchecked items stay out of sync in both directions and nothing is deleted when they are re-included", async () => {
      await A.write("Pick/keep.md", "keep\n");
      await A.write("Pick/Skip/a.md", "a v1\n");
      await A.write("Pick/Skip/b.md", "b v1\n");
      await until("pick files uploaded", async () => (await remoteTree()).files.has("Pick/Skip/b.md"), 90_000);
      await B.runSyncNow();
      await until("ipad has pick files", () => B.exists("Pick/Skip/b.md"), 60_000);

      const listing = await A.plugin.listSyncTree("Pick");
      const names = listing.entries.map((entry: any) => `${entry.name}${entry.isFolder ? "/" : ""}:${entry.onDevice ? "d" : ""}${entry.onServer ? "s" : ""}`).sort().join(",");
      if (!listing.serverReachable || names !== "Skip/:ds,keep.md:ds") throw new Error(`Unexpected picker listing: ${names} reachable=${listing.serverReachable}`);

      await A.plugin.setSyncSelection("Pick/Skip", false);
      if (JSON.stringify(A.plugin.syncSelectionExcludes()) !== '["Pick/Skip"]') throw new Error("The exclusion was not stored.");
      // desktop edits and device-local deletion of an excluded folder never reach the server
      await A.write("Pick/Skip/a.md", "a v2 edited while excluded\n");
      await B.write("Pick/Skip/c.md", "c from ipad\n");
      await until("ipad c.md uploaded", async () => (await remoteTree()).files.has("Pick/Skip/c.md"), 90_000);
      await A.runSyncNow();
      await sleep(3000);
      let tree = await remoteTree();
      if (tree.files.get("Pick/Skip/a.md") === sha(Buffer.from("a v2 edited while excluded\n"))) throw new Error("An excluded edit was uploaded.");
      if (A.exists("Pick/Skip/c.md")) throw new Error("An excluded remote file was downloaded.");
      await A.removeRecursive("Pick/Skip");
      await A.runSyncNow();
      await sleep(3000);
      tree = await remoteTree();
      if (!tree.files.has("Pick/Skip/a.md") || !tree.files.has("Pick/Skip/b.md") || !tree.files.has("Pick/Skip/c.md") || !tree.folders.has("Pick/Skip")) throw new Error(`Deleting an excluded folder locally removed server data: ${fmt(tree)}`);
      if (!B.exists("Pick/Skip/b.md")) throw new Error("The other device lost an excluded file.");

      await A.plugin.setSyncSelection("Pick/Skip", true);
      await A.runSyncNow();
      await until("re-included folder is downloaded again", () => A.exists("Pick/Skip/a.md") && A.exists("Pick/Skip/b.md") && A.exists("Pick/Skip/c.md"), 90_000);
      tree = await remoteTree();
      if (!tree.files.has("Pick/Skip/a.md") || !tree.files.has("Pick/Skip/c.md")) throw new Error(`Re-including deleted server data: ${fmt(tree)}`);
      if (A.plugin.syncSelectionExcludes().length !== 0) throw new Error("Re-including did not clear the exclusion.");
    });

    await step("a new vault pointed at a Nextcloud folder that does not exist yet creates it and syncs", async () => {
      const fresh = `${REMOTE_ROOT}/Fresh Vault`;
      const C = new Device("fresh", base, manifest, { mobile: false });
      devices.push(C);
      C.seedAccount({ serverUrl: SERVER, userId: USER, appPassword: PASSWORD, remoteRootPath: fresh });
      try {
        await C.start();
        await C.write("hello.md", "first note in a brand new vault\n");
        await until("missing folder was created and the note uploaded", async () => (await dav("GET", `${fresh}/hello.md`)).status === 200, 90_000);
      } finally {
        await C.stop();
        devices.splice(devices.indexOf(C), 1);
      }
    });

    await step("mass-deletion guard holds deletions, undo restores them, approval performs them", async () => {
      await configure(A, (settings) => { settings.deleteConfirmThreshold = 3; });
      for (let i = 1; i <= 6; i += 1) await A.write(`Guard/f${i}.md`, `guarded file ${i}\n`);
      await until("guard files uploaded", async () => { const t = await remoteTree(); return [1, 2, 3, 4, 5, 6].every((i) => t.files.has(`Guard/f${i}.md`)); }, 90_000);
      await B.runSyncNow();
      await until("ipad has guard files", () => B.exists("Guard/f6.md"), 60_000);

      await A.removeRecursive("Guard");
      await until("deletions are held", () => (A.plugin.pendingDeletions()?.total ?? 0) >= 6, 60_000);
      await sleep(3000);
      if (!(await remoteTree()).files.has("Guard/f1.md")) throw new Error("Held deletions reached the server.");
      const restored = await A.plugin.undoPendingLocalDeletions();
      if (restored !== 6 || !A.exists("Guard/f3.md")) throw new Error(`Undo restored ${restored} file(s).`);
      await A.runSyncNow();
      if (A.plugin.pendingDeletions() !== null || !(await remoteTree()).files.has("Guard/f3.md")) throw new Error("Undo left a pending hold or damaged the server copy.");

      await A.removeRecursive("Guard");
      await until("deletions are held again", () => (A.plugin.pendingDeletions()?.total ?? 0) >= 6, 60_000);
      if (!A.plugin.approvePendingDeletions()) throw new Error("Nothing to approve.");
      await A.runSyncNow();
      await until("approved deletions reached the server", async () => !(await remoteTree()).files.has("Guard/f1.md"), 90_000);
      await B.runSyncNow();
      await until("ipad lost guard files", () => !B.exists("Guard/f1.md"), 60_000);
      if (A.plugin.pendingDeletions() !== null) throw new Error("Hold was not cleared after approval.");
      await configure(A, (settings) => { settings.deleteConfirmThreshold = 20; });
    });

    await step("deleted files are restorable from retained copies and from the Nextcloud trash bin", async () => {
      const deleted = await A.plugin.recentlyDeleted();
      const f1 = deleted.find((entry: { path: string }) => entry.path === "Guard/f1.md");
      if (!f1) throw new Error(`Ledger lacks the deleted file: ${JSON.stringify(deleted.map((entry: { path: string }) => entry.path))}`);
      const path = await A.plugin.restoreDeletedFile(f1);
      if (path !== "Guard/f1.md" || A.read(path).toString() !== "guarded file 1\n") throw new Error("Restored file differs.");
      await until("restored file synced to the server", async () => (await remoteText("Guard/f1.md")) === "guarded file 1\n", 90_000);

      const trash = await A.plugin.listNextcloudTrash();
      const f2 = trash.find((item: { originalLocation: string }) => item.originalLocation === `${REMOTE_ROOT}/Guard/f2.md`);
      if (!f2) throw new Error(`Nextcloud trash lacks the deleted file (${trash.length} items).`);
      await A.plugin.restoreFromNextcloudTrash(f2);
      await until("trash restore visible on the server", async () => (await remoteText("Guard/f2.md")) === "guarded file 2\n", 30_000);
      await A.runSyncNow();
      await until("trash-restored file downloaded", () => A.exists("Guard/f2.md"), 60_000);
      await until("desktop finished recording the download", () => !A.plugin.isSyncBusy(), 60_000);
      await A.runSyncNow(); // BASE for the restored file is established before the user deletes it again
      await A.removeRecursive("Guard");
      await until("cleanup of guard folder", async () => { const t = await remoteTree(); return ![...t.files.keys(), ...t.folders].some((p) => p.startsWith("Guard")); }, 90_000);
    });

    await step("a user size limit skips large files on that device only and lifting it downloads them", async () => {
      await configure(B, (settings) => { settings.maxFileSizeMiB = 1; });
      const medium = randomBytes(2 * 1024 * 1024);
      await A.write("Media/medium.bin", medium);
      await until("medium file on server", async () => (await remoteTree()).files.get("Media/medium.bin") === sha(medium), 120_000);
      await B.runSyncNow();
      await sleep(2000);
      if (B.exists("Media/medium.bin")) throw new Error("iPad downloaded a file above its configured limit.");
      if (!B.plugin.skippedLargeFiles().remote.includes("Media/medium.bin")) throw new Error("Skipped file is not reported.");
      await configure(B, (settings) => { settings.maxFileSizeMiB = 0; });
      await B.runSyncNow();
      await until("ipad downloads after lifting the limit", () => B.exists("Media/medium.bin") && sha(B.read("Media/medium.bin")) === sha(medium), 90_000);
      await A.removeRecursive("Media/medium.bin");
      await until("medium file removed", async () => !(await remoteTree()).files.has("Media/medium.bin"), 90_000);
    });

    await step("previous versions can be listed, compared and restored as a copy or in place", async () => {
      for (const text of ["first draft\n", "second draft with more\n", "third and final\n"]) {
        await A.write("Versioned.md", text);
        await until(`server has "${text.trim()}"`, async () => (await remoteText("Versioned.md")) === text, 90_000);
        await sleep(2200); // Nextcloud keeps at most one version per second
      }
      const versions = await A.plugin.fileVersions("Versioned.md");
      if (versions.length < 2) throw new Error(`Expected at least two versions, got ${versions.length}.`);
      const oldest = versions[versions.length - 1];
      const pair = await A.plugin.compareFileVersion("Versioned.md", oldest);
      if (!pair || pair.current !== "third and final\n" || pair.version !== "first draft\n") throw new Error(`Unexpected comparison: ${JSON.stringify(pair)}`);
      const copyPath = await A.plugin.restoreFileVersion("Versioned.md", oldest, "copy");
      if (A.read(copyPath).toString() !== "first draft\n" || !copyPath.startsWith("Versioned (version ")) throw new Error(`Copy restore wrote ${copyPath}.`);
      const middle = versions.find((version: { size: number }) => version.size === Buffer.byteLength("second draft with more\n"));
      if (!middle) throw new Error("Middle version missing.");
      await A.plugin.restoreFileVersion("Versioned.md", middle, "replace");
      if (A.read("Versioned.md").toString() !== "second draft with more\n") throw new Error("In-place restore failed.");
      await until("restored text synced to the server and the iPad", async () => (await remoteText("Versioned.md")) === "second draft with more\n" && (B.exists("Versioned.md") && B.read("Versioned.md").toString() === "second draft with more\n" || (await B.runSyncNow(), false)), 120_000, 2000);
      await A.write("Versioned.md", "local change not synced yet\n");
      let refused = false;
      try { await A.plugin.restoreFileVersion("Versioned.md", middle, "replace"); } catch { refused = true; }
      if (!refused && A.read("Versioned.md").toString() !== "local change not synced yet\n") throw new Error("Replace overwrote an unsynced change.");
      await A.removeRecursive(copyPath);
      await A.removeRecursive("Versioned.md");
      await until("version files removed", async () => { const t = await remoteTree(); return !t.files.has("Versioned.md") && ![...t.files.keys()].some((p) => p.startsWith("Versioned (version")); }, 90_000);
    });

    await step("a real conflict can be compared and then kept as both versions without data loss", async () => {
      await A.write("Conflict.md", "line one\nshared line\nline three\n");
      await until("conflict base on server", async () => (await remoteText("Conflict.md")) !== null, 90_000);
      await B.runSyncNow();
      await until("ipad has base", () => B.exists("Conflict.md"), 60_000);
      await configure(B, (settings) => { settings.syncPaused = true; });
      await A.write("Conflict.md", "line one\nEDITED BY DESKTOP\nline three\n");
      await until("desktop edit on server", async () => (await remoteText("Conflict.md"))?.includes("DESKTOP") === true, 90_000);
      await B.write("Conflict.md", "line one\nEDITED BY IPAD\nline three\n");
      await B.runSyncNow(); // verifies the remote content
      await B.runSyncNow(); // classifies the overlapping edits
      const review = B.plugin.syncConflictReviews().find((entry: { path: string }) => entry.path === "Conflict.md");
      if (!review) throw new Error("The overlapping edits were not surfaced as a conflict.");
      const preview = await B.plugin.conflictPreview(review.entryId);
      if (preview.unavailable || !preview.local?.includes("IPAD") || !preview.remote?.includes("DESKTOP") || !preview.base?.includes("shared line")) throw new Error(`Bad preview: ${JSON.stringify(preview).slice(0, 300)}`);
      if (process.env.NYRA_E2E_RAW_LOG) console.log("REVIEW", JSON.stringify(review));
      await B.plugin.resolveConflict(review.entryId, "keep-both");
      const names = B.walk("").files.filter((name: string) => name.startsWith("Conflict"));
      const texts = names.map((name: string) => B.read(name).toString());
      if (!texts.some((text: string) => text.includes("IPAD")) || !texts.some((text: string) => text.includes("DESKTOP"))) throw new Error(`A conflicting version was lost: ${names.join(", ")}`);
      await B.plugin.resolveConflict(review.entryId, "keep-remote");
      await configure(B, (settings) => { settings.syncPaused = false; });
      if (B.read("Conflict.md").toString() !== "line one\nEDITED BY DESKTOP\nline three\n") throw new Error("Keep-remote did not apply the desktop version.");
      if (![...B.walk("").files].some((name: string) => name.startsWith("Conflict (Nyra conflict LOCAL") && B.read(name).toString().includes("IPAD"))) throw new Error("The displaced iPad version was not preserved.");
      for (const name of B.walk("").files.filter((candidate: string) => candidate.startsWith("Conflict (Nyra conflict"))) await B.removeRecursive(name);
      await A.removeRecursive("Conflict.md");
      await until("conflict files removed everywhere", async () => { const t = await remoteTree(); return ![...t.files.keys()].some((p) => p.startsWith("Conflict")); }, 120_000, 2000);
      await B.runSyncNow();
      await until("ipad lost the resolved conflict note", () => !B.exists("Conflict.md"), 60_000);
    });

    const oversize = randomBytes(34 * 1024 * 1024); // above the iPad's 32 MiB whole-file limit
    await step("files above the iPad memory limit are skipped there without blocking anything else or being deleted", async () => {
      await A.write("Media/video.bin", oversize);
      await B.write("Local Only Big.bin", randomBytes(34 * 1024 * 1024));
      await B.write("After Big.md", "small file next to oversized ones\n");
      await until("remote has desktop video and iPad small note", async () => {
        const t = await remoteTree();
        return t.files.get("Media/video.bin") === sha(oversize) && t.files.has("After Big.md");
      }, 240_000, 2000);
      await B.runSyncNow(); await A.runSyncNow();
      if (B.exists("Media/video.bin")) throw new Error("iPad downloaded a file above its memory limit.");
      if ((await remoteTree()).files.has("Local Only Big.bin")) throw new Error("iPad uploaded a file above its memory limit.");
      if (!B.exists("Local Only Big.bin")) throw new Error("iPad's oversized local file disappeared.");
      await A.removeRecursive("Media/video.bin");
      await until("remote lost video", async () => !(await remoteTree()).files.has("Media/video.bin"), 120_000);
      await B.runSyncNow();
      if (!B.exists("Local Only Big.bin") || !B.exists("After Big.md")) throw new Error("iPad lost files while oversized neighbours were present.");
      await B.removeRecursive("Local Only Big.bin");
    });

    await step("restart keeps state; an edit made while the plugin was off is uploaded", async () => {
      await A.stop();
      await A.write("Offline Edit.md", "written while plugin was stopped\n");
      await A.start();
      await A.runSyncNow();
      await until("remote has offline edit", async () => (await remoteTree()).files.has("Offline Edit.md"), 90_000);
      await B.runSyncNow();
      await until("ipad has offline edit", () => B.exists("Offline Edit.md"), 60_000);
    });

    await step("idle background polls are answered by the one-request root ETag check", async () => {
      for (const device of [A, B]) {
        await until(`${device.name} verified the fast check`, () => device.plugin.remotePollStats().fastCheckVerified !== null, 120_000);
        if (device.plugin.remotePollStats().fastCheckVerified !== true) throw new Error(`${device.name}: server did not pass the root ETag propagation probe.`);
      }
      const before = A.plugin.remotePollStats();
      await until("some idle polls were skipped", () => A.plugin.remotePollStats().skipped > before.skipped, 240_000, 2000);
      // A remote change must still be noticed promptly by the next poll.
      await B.write("Poll Check.md", "created on the other device\n");
      await until("desktop notices the change despite the shortcut", () => A.exists("Poll Check.md"), 240_000, 2000);
    });

    await step("final convergence: desktop == server == iPad, no conflict copies", async () => {
      await A.runSyncNow(); await B.runSyncNow(); await A.runSyncNow();
      const remote = await remoteTree();
      if (!sameTree(localTree(A), remote) || !sameTree(localTree(B), remote)) {
        throw new Error(`Trees differ.\n desktop: ${fmt(localTree(A))}\n ipad: ${fmt(localTree(B))}\n server: ${fmt(remote)}`);
      }
      if ([...remote.files.keys()].some((f) => f.includes("conflict"))) throw new Error("Unexpected conflict copy.");
    });
    console.log(`\nLIVE E2E PASS — ${results.length} scenarios`);
  } catch (error) {
    exitCode = 1;
    console.error("\nLIVE E2E FAIL:", error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    for (const device of [A, B]) await device.stop().catch(() => undefined);
    await sleep(500); // let in-flight plugin writes settle before removing the directories
    await dav("DELETE", REMOTE_ROOT).catch((error: unknown) => console.warn("Remote cleanup failed:", error));
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { console.warn("Local cleanup failed:", error); }
    process.exit(exitCode);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
