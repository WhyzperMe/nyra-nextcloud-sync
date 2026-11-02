import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Device } from "./device";

/**
 * Live benchmark of serial versus parallel file transfers against a real Nextcloud (opt-in, same variables as
 * live-e2e: NYRA_E2E_SERVER, NYRA_E2E_USER, NYRA_E2E_APP_PASSWORD, NYRA_E2E_PARENT). Every configuration uses a fresh,
 * uniquely named remote folder that is deleted afterwards, uploads from one device and downloads to a second one,
 * and verifies all content by SHA-256 through independent WebDAV requests. It measures this machine, this network and this
 * server only; it says nothing about phones.
 */
const env = (name: string): string => { const v = process.env[name]; if (!v) throw new Error(`Missing ${name}`); return v; };
const SERVER = env("NYRA_E2E_SERVER").replace(/\/+$/, "");
const USER = env("NYRA_E2E_USER");
const PASSWORD = env("NYRA_E2E_APP_PASSWORD");
const PARENT = env("NYRA_E2E_PARENT").replace(/^\/+|\/+$/g, "");
const WORKERS = (process.env.NYRA_BENCH_WORKERS ?? "1,2,4,8").split(",").map((v) => Number.parseInt(v, 10));
const FILES = Number.parseInt(process.env.NYRA_BENCH_FILES ?? "40", 10);
const DAV = `${SERVER}/remote.php/dav/files/${encodeURIComponent(USER)}`;
const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "manifest.json"), "utf8"));
const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const dav = async (method: string, p: string, headers: Record<string, string> = {}): Promise<Response> => await fetch(`${DAV}/${enc(p)}`, { method, headers: { Authorization: AUTH, ...headers } });

async function configure(device: Device, mutator: (settings: any) => void): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await device.plugin.updateSettings(mutator); return; }
    catch (error) { if (!String(error).includes("while synchronization is active")) throw error; await sleep(500); }
  }
  throw new Error("Settings stayed locked by a running sync.");
}

async function remoteHashes(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [""];
  while (queue.length) {
    const dir = queue.pop()!;
    const xml = await (await dav("PROPFIND", `${root}${dir ? `/${dir}` : ""}`, { Depth: "1" })).text();
    for (const block of xml.split("<d:response>").slice(1)) {
      const href = decodeURIComponent(/<d:href>([^<]*)<\/d:href>/.exec(block)![1]!);
      const rel = href.slice(href.indexOf(`/${root}`) + root.length + 2).replace(/\/$/, "");
      if (rel === "" || rel === dir || rel.split("/").includes(".nyra-nextcloud-sync-runtime")) continue;
      if (block.includes("<d:collection/>")) queue.push(rel);
      else out.set(rel, sha(Buffer.from(await (await dav("GET", `${root}/${rel}`)).arrayBuffer())));
    }
  }
  return out;
}

async function once(workers: number, content: Map<string, Buffer>): Promise<{ uploadMs: number; downloadMs: number }> {
  const root = `${PARENT}/bench-${workers}w-${Date.now().toString(36)}`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-bench-"));
  const A = new Device("desktop", base, manifest, { mobile: false });
  const B = new Device("second", base, manifest, { mobile: false });
  try {
    for (const d of [A, B]) d.seedAccount({ serverUrl: SERVER, userId: USER, appPassword: PASSWORD, remoteRootPath: root });
    let prefix = "";
    for (const segment of root.split("/")) { prefix = prefix ? `${prefix}/${segment}` : segment; await dav("MKCOL", prefix); }
    await A.start(); await B.start();
    for (const d of [A, B]) await configure(d, (s) => { s.transferConcurrency = workers; s.transferMemoryMiB = 64; s.syncPaused = true; });
    for (const [p, bytes] of content) await A.write(p, bytes);
    await configure(A, (s) => { s.syncPaused = false; });
    const upStart = Date.now();
    for (let i = 0; i < 6; i += 1) { await A.runSyncNow(); if ((await remoteHashes(root)).size >= content.size) break; }
    const uploadMs = Date.now() - upStart;
    const remote = await remoteHashes(root);
    for (const [p, bytes] of content) if (remote.get(p) !== sha(bytes)) throw new Error(`Upload mismatch for ${p} with ${workers} workers.`);
    await configure(B, (s) => { s.syncPaused = false; });
    const downStart = Date.now();
    for (let i = 0; i < 6; i += 1) { await B.runSyncNow(); if ([...content.keys()].every((p) => B.exists(p))) break; }
    const downloadMs = Date.now() - downStart;
    for (const [p, bytes] of content) if (sha(B.read(p)) !== sha(bytes)) throw new Error(`Download mismatch for ${p} with ${workers} workers.`);
    return { uploadMs, downloadMs };
  } finally {
    for (const d of [A, B]) await d.stop().catch(() => undefined);
    await dav("DELETE", root).catch(() => undefined);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const content = new Map<string, Buffer>();
  for (let i = 0; i < FILES; i += 1) content.set(`Bench ${i % 6}/note-${i}.${i % 10 === 0 ? "bin" : "md"}`, randomBytes(i % 10 === 0 ? 1_500_000 : 4_000));
  const total = [...content.values()].reduce((sum, b) => sum + b.length, 0);
  console.log(`Live benchmark: ${content.size} files (${(total / 1024 / 1024).toFixed(1)} MiB) in 6 folders against ${SERVER}`);
  const rows: string[] = [];
  for (const workers of WORKERS) {
    const r = await once(workers, content);
    rows.push(`${workers} worker${workers > 1 ? "s" : " "}: upload ${(r.uploadMs / 1000).toFixed(1)} s, download ${(r.downloadMs / 1000).toFixed(1)} s`);
    console.log(rows[rows.length - 1]);
  }
  console.log("LIVE BENCH DONE");
}
main().catch((error) => { console.error("LIVE BENCH FAIL:", error); process.exitCode = 1; });
