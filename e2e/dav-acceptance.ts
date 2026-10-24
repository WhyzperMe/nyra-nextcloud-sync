import { basicAuthorization } from "../src/security/base64";
import { nextcloudEndpoints } from "../src/nextcloud/endpoints";
import { parseDavMultistatus, type DavPropertyResponse } from "../src/remote/dav-xml";
import { appendWebdavPath, relativePathFromDavHref } from "../src/remote/path";
import { sha256Hex } from "../src/state/durable/crypto";
import { validateAcceptanceConfig, uniqueAcceptancePath } from "./acceptance-safety";
import { runEngineScenarios } from "./engine-scenarios";
import { acceptanceRequestOptions } from "./acceptance-request";

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

const XML_PROPFIND = `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/><oc:fileid/></d:prop></d:propfind>`;
const MIB = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * MIB;

interface DavReply { status: number; headers: Headers; bytes: Uint8Array; text: string; }
interface VerifiedDavFile extends DavPropertyResponse { etag: string; fileId: string; }

async function main(): Promise<void> {
  // Configuration and destructive acknowledgement are validated before any network request.
  const config = validateAcceptanceConfig(process.env);
  const runId = `nyra-acceptance-${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  const testPath = uniqueAcceptancePath(config.remoteRoot, runId);
  const auth = basicAuthorization(config.userId, config.appPassword);
  const userRoot = nextcloudEndpoints.webdavUserRoot(config.serverUrl, config.userId);
  const testRootUrl = appendWebdavPath(userRoot, testPath);
  let testRootCreated = false;
  let cleanupEntries = 0;
  let operationFailure: unknown = null;
  const checks: string[] = [];

  try {
    const base = await request(appendWebdavPath(userRoot, config.remoteRoot), "PROPFIND", { Depth: "0" });
    requireStatus(base, [207], "configured test root is not an existing WebDAV collection");
    if (!parseDavMultistatus(base.text).some((row) => row.isCollection)) throw new Error("Acceptance root PROPFIND did not return a collection.");
    checks.push("PROPFIND dedicated root");

    requireStatus(await request(testRootUrl, "PROPFIND", { Depth: "0" }), [404], "generated test directory already exists");
    let created: DavReply;
    try { created = await request(testRootUrl, "MKCOL"); }
    catch (error) {
      if ((await request(testRootUrl, "PROPFIND", { Depth: "0" }).catch(() => null))?.status === 207) testRootCreated = true;
      throw error;
    }
    requireStatus(created, [201], "unique test directory was not newly created");
    testRootCreated = true;
    checks.push("unique isolated test directory");

    const spaced = appendWebdavPath(testRootUrl, "folder with spaces");
    const deep = appendWebdavPath(spaced, "深い folder");
    requireStatus(await request(spaced, "MKCOL"), [201], "space folder creation failed");
    requireStatus(await request(deep, "MKCOL"), [201], "Unicode/deep folder creation failed");

    const unicodeName = "note 📝 #? %.md";
    const original = new TextEncoder().encode("acceptance original\n");
    const unicodeUrl = appendWebdavPath(deep, unicodeName);
    const firstPut = await request(unicodeUrl, "PUT", { "If-None-Match": "*", "Content-Type": "application/octet-stream" }, original);
    requireStatus(firstPut, [201, 204], "create-only PUT failed");
    requireStatus(await request(unicodeUrl, "PUT", { "If-None-Match": "*" }, new TextEncoder().encode("must not replace")), [412], "If-None-Match create-only precondition was not enforced");
    const initial = await stat(unicodeUrl);
    if (!initial.fileId || !initial.etag || initial.size !== original.byteLength) throw new Error("Created DAV object lacks a fileId, strong ETag, or expected size.");
    checks.push("create-only PUT, Unicode filename, spaces, deep path");

    const updatedBytes = new TextEncoder().encode("acceptance updated bytes\n");
    const updateReply = await request(unicodeUrl, "PUT", { "If-Match": initial.etag }, updatedBytes);
    requireStatus(updateReply, [200, 201, 204], "If-Match update failed");
    const staleBytes = new TextEncoder().encode("stale write");
    const staleReply = await request(unicodeUrl, "PUT", { "If-Match": initial.etag }, staleBytes);
    if (staleReply.status !== 412) {
      const readback = await request(unicodeUrl, "GET");
      const updateEtag = updateReply.headers.get("etag") ?? updateReply.headers.get("oc-etag");
      const etagAdvanced = updateEtag === null ? "not reported" : String(updateEtag !== initial.etag);
      const staleVisible = readback.status === 200 && await sha256Hex(readback.bytes) === await sha256Hex(staleBytes);
      throw new Error(`stale ETag was not rejected (HTTP ${staleReply.status}; update response ETag advanced: ${etagAdvanced}; stale payload visible: ${staleVisible}).`);
    }
    const updated = await stat(unicodeUrl);
    if (updated.fileId !== initial.fileId || updated.etag === initial.etag) throw new Error("Update did not preserve fileId while advancing the ETag.");
    checks.push("If-Match update and stale ETag rejection");

    const movedUrl = appendWebdavPath(deep, "moved note.md");
    requireStatus(await request(unicodeUrl, "MOVE", { Destination: movedUrl, Overwrite: "F", "If-Match": updated.etag }), [201, 204], "preconditioned MOVE failed");
    const moved = await stat(movedUrl);
    if (moved.fileId !== initial.fileId) throw new Error("Nextcloud MOVE did not preserve the fileId.");
    checks.push("MOVE identity continuity");

    const range = await request(movedUrl, "GET", { Range: "bytes=2-5", "If-Match": moved.etag });
    requireStatus(range, [206], "byte-range GET was not honored");
    if (new TextDecoder().decode(range.bytes) !== "cept") throw new Error("Range GET returned unexpected bytes.");
    checks.push("range download");

    const emptyUrl = appendWebdavPath(testRootUrl, "empty zero-byte file.bin");
    requireStatus(await request(emptyUrl, "PUT", { "If-None-Match": "*" }, new Uint8Array(0)), [201, 204], "zero-byte create failed");
    if ((await stat(emptyUrl)).size !== 0) throw new Error("Zero-byte file size was not preserved.");
    checks.push("zero-byte file");

    await validateChunkResume(config.serverUrl, config.userId, testRootUrl, runId, auth);
    checks.push("resumed Nextcloud chunk upload v2 and lost-part isolation");

    // Two independent clients observe one ETag. The first update wins; a stale second update is blocked.
    const peerUrl = appendWebdavPath(testRootUrl, "two-device note.md");
    const deviceABase = new TextEncoder().encode("base\nleft\nright\n");
    requireStatus(await request(peerUrl, "PUT", { "If-None-Match": "*" }, deviceABase), [201, 204], "two-device fixture create failed");
    const deviceA = await stat(peerUrl);
    const deviceB = await stat(peerUrl);
    const deviceAEdit = new TextEncoder().encode("A edit\nleft\nright\n");
    requireStatus(await request(peerUrl, "PUT", { "If-Match": deviceA.etag }, deviceAEdit), [200, 201, 204], "device A update failed");
    requireStatus(await request(peerUrl, "PUT", { "If-Match": deviceB.etag }, new TextEncoder().encode("base\nleft\nB edit\n")), [412], "stale device B update was not blocked");
    const afterA = await stat(peerUrl);
    const mergedBytes = new TextEncoder().encode("A edit\nleft\nB edit\n");
    requireStatus(await request(peerUrl, "PUT", { "If-Match": afterA.etag }, mergedBytes), [200, 201, 204], "explicit two-device merge update failed");
    const peer = await request(peerUrl, "GET");
    if (await sha256Hex(peer.bytes) !== await sha256Hex(mergedBytes)) throw new Error("Two-device convergence read-back hash mismatch.");
    checks.push("two-device stale-write fence and converged read-back");

    // A fresh client lookup models reconnect/next-device bootstrap discovery.
    const bootstrapInventory = await request(testRootUrl, "PROPFIND", { Depth: "1" });
    requireStatus(bootstrapInventory, [207], "bootstrap inventory failed");
    if (!parseDavMultistatus(bootstrapInventory.text).some((row) => row.href.includes(encodeURIComponent("two-device note.md")))) {
      throw new Error("Fresh inventory did not discover the two-device file.");
    }
    checks.push("reconnect/bootstrap inventory");

    // Exercise conditional DELETE; recursive cleanup below is still scoped to this unique directory.
    const peerAfter = await stat(peerUrl);
    requireStatus(await request(peerUrl, "DELETE", { "If-Match": peerAfter.etag ?? "" }), [204], "conditional DELETE failed");
    if ((await request(peerUrl, "PROPFIND", { Depth: "0" })).status !== 404) throw new Error("Deleted object remained visible.");
    checks.push("conditional DELETE");

    // Dispatch both stale-base writes together; cleanup waits for both requests.
    const raceUrl = appendWebdavPath(testRootUrl, "concurrent conditional write.md");
    const raceBase = new TextEncoder().encode("base edit\n");
    const raceBodies = [new TextEncoder().encode("peer A!!!\n"), new TextEncoder().encode("peer B!!!\n")];
    requireStatus(await request(raceUrl, "PUT", { "If-None-Match": "*" }, raceBase), [201], "concurrent fixture creation failed");
    const raceObserved = await stat(raceUrl);
    const raced = await Promise.allSettled(raceBodies.map((body) => request(raceUrl, "PUT", { "If-Match": raceObserved.etag }, body)));
    const accepted: number[] = [];
    for (const [index, reply] of raced.entries()) {
      if (reply.status === "rejected") throw new Error("A simultaneous conditional-write request failed in transport.");
      requireStatus(reply.value, [200, 201, 204, 412, 423], "unexpected simultaneous conditional-write status");
      if ([200, 201, 204].includes(reply.value.status)) accepted.push(index);
    }
    if (accepted.length > 1) throw new Error("Two simultaneous writes with the same old ETag both committed.");
    const raceContent = await request(raceUrl, "GET");
    requireStatus(raceContent, [200], "concurrent result read-back failed");
    const expectedRaceBody = accepted.length === 1 ? raceBodies[accepted[0]!]! : raceBase;
    if (await sha256Hex(raceContent.bytes) !== await sha256Hex(expectedRaceBody)) throw new Error("Simultaneous conditional-write read-back did not match the accepted request.");
    checks.push("simultaneous same-ETag writes: at most one commit, verified bytes");

    checks.push(...await runEngineScenarios(config, `${testPath}/engine`, {
      request: async (input) => {
        const headers = { ...input.headers };
        if (input.contentType) headers["Content-Type"] = input.contentType;
        const body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body === undefined ? undefined : new Uint8Array(input.body);
        const reply = await request(input.url, input.method ?? "GET", headers, body);
        const responseHeaders: Record<string, string> = {};
        reply.headers.forEach((value, key) => { responseHeaders[key] = value; });
        const bytes = new Uint8Array(reply.bytes);
        return { status: reply.status, headers: responseHeaders, text: reply.text, arrayBuffer: bytes.buffer, json: () => JSON.parse(reply.text) as unknown };
      }
    }));

    const server = new URL(config.serverUrl);
    console.log("Live Nextcloud acceptance: PASS", { origin: server.origin, checks });
  } catch (error) {
    console.error("Live acceptance stopped after:", checks.at(-1) ?? "initial WebDAV preflight");
    operationFailure = error;
  } finally {
    let cleanupFailed = false;
    if (acceptanceUploadSession) {
      const uploadCleanup = await request(acceptanceUploadSession, "DELETE").catch(() => null);
      if (!uploadCleanup || ![204, 404].includes(uploadCleanup.status)) {
        console.warn("Unique upload-session cleanup did not complete; its path is intentionally omitted.");
        cleanupFailed = true;
      }
      acceptanceUploadSession = null;
    }
    if (testRootCreated) {
      try { await deleteUniqueTree(testRootUrl); }
      catch (error) {
        console.warn("Scoped cleanup could not remove the unique acceptance directory; no path outside that directory was touched.",
          error instanceof Error ? error.message : "Unknown cleanup failure.");
        cleanupFailed = true;
      }
    }
    if (cleanupFailed && operationFailure === null) throw new Error("Live acceptance failed its scoped cleanup check.");
  }
  if (operationFailure !== null) throw operationFailure;

  async function deleteUniqueTree(directoryUrl: string, depth = 0): Promise<void> {
    if (depth > 64) throw new Error("Scoped cleanup exceeded its 64-level depth limit.");
    const listing = await request(directoryUrl, "PROPFIND", { Depth: "1" });
    if (listing.status === 404) return;
    requireStatus(listing, [207], "scoped cleanup inventory failed");
    const children: Array<{ url: string; row: DavPropertyResponse }> = [];
    for (const row of parseDavMultistatus(listing.text)) {
      const relative = relativePathFromDavHref(directoryUrl, row.href);
      if (relative === null) continue;
      children.push({ url: appendWebdavPath(directoryUrl, relative), row });
      cleanupEntries += 1;
      if (cleanupEntries > 10_000) throw new Error("Scoped cleanup exceeded its 10,000-entry safety limit.");
    }
    for (const child of children) {
      if (child.row.isCollection) await deleteUniqueTree(child.url, depth + 1);
      const current = await request(child.url, "PROPFIND", { Depth: "0" });
      if (current.status === 404) continue;
      requireStatus(current, [207], "scoped cleanup precondition lookup failed");
      const latest = parseDavMultistatus(current.text).find((row) => row.isCollection === child.row.isCollection);
      const etag = latest?.etag;
      if (!latest || (!child.row.isCollection && (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)))) {
        throw new Error("Scoped cleanup could not prove the generated file's current ETag.");
      }
      if (latest.fileId !== child.row.fileId) throw new Error("Scoped cleanup detected a changed generated file identity.");
      const precondition = etag && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) ? { "If-Match": etag } : {};
      requireStatus(await request(child.url, "DELETE", precondition), [204, 404], "conditional scoped cleanup failed");
    }
    const remaining = await request(directoryUrl, "PROPFIND", { Depth: "1" });
    if (remaining.status === 404) return;
    requireStatus(remaining, [207], "acceptance root cleanup lookup failed");
    const rows = parseDavMultistatus(remaining.text);
    if (rows.length !== 1 || !rows[0]?.isCollection) throw new Error("Acceptance cleanup found new content in the generated directory.");
    const collection = rows[0];
    const etag = collection?.etag;
    const rootPrecondition = etag && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) ? { "If-Match": etag } : {};
    const deletion = await request(directoryUrl, "DELETE", rootPrecondition);
    if (deletion.status === 412 && etag) {
      // Nextcloud can asynchronously advance a collection ETag after its last
      // child is removed. Re-prove this UUID-only directory is still empty.
      const retryInventory = await request(directoryUrl, "PROPFIND", { Depth: "1" });
      requireStatus(retryInventory, [207], "acceptance cleanup retry inventory failed");
      const retryRows = parseDavMultistatus(retryInventory.text);
      if (retryRows.length !== 1 || !retryRows[0]?.isCollection || retryRows[0].fileId !== collection.fileId) {
        throw new Error("Acceptance cleanup retry found changed directory identity or new content.");
      }
      requireStatus(await request(directoryUrl, "DELETE"), [204, 404], "unique empty acceptance-root cleanup failed");
    } else {
      requireStatus(deletion, [204, 404], "unique acceptance-root cleanup failed");
    }
  }

  async function request(url: string, method: string, extraHeaders: Record<string, string> = {}, body?: Uint8Array): Promise<DavReply> {
    const options = acceptanceRequestOptions(auth, method, extraHeaders, body, XML_PROPFIND, 30_000);
    const response = await fetch(url, options);
    if (response.status >= 300 && response.status < 400) throw new Error("Nextcloud redirected an acceptance request; redirects are rejected.");
    const bytes = await readBounded(response);
    return { status: response.status, headers: response.headers, bytes, text: new TextDecoder().decode(bytes) };
  }

  async function stat(url: string): Promise<VerifiedDavFile> {
    const response = await request(url, "PROPFIND", { Depth: "0" });
    requireStatus(response, [207], "file stat PROPFIND failed");
    const rows = parseDavMultistatus(response.text);
    const file = rows.find((entry) => !entry.isCollection);
    const fileId = file?.fileId;
    const etag = file?.etag;
    if (!file || !fileId) throw new Error("File stat response did not contain a file ID.");
    if (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) throw new Error("File stat response returned a weak, missing, or malformed ETag.");
    return { ...file, etag, fileId };
  }
}

async function validateChunkResume(
  serverUrl: string,
  userId: string,
  testRootUrl: string,
  runId: string,
  auth: string
): Promise<void> {
  const uploadRoot = nextcloudEndpoints.webdavUploadsRoot(serverUrl, userId);
  const sessionPath = `nyra-acceptance-${runId.replace(/^nyra-acceptance-/, "")}`;
  const sessionUrl = appendWebdavPath(uploadRoot, sessionPath);
  requireStatus(await request(sessionUrl, "PROPFIND", { Depth: "0" }), [404], "generated upload session already exists");
  let createSession: DavReply;
  try { createSession = await request(sessionUrl, "MKCOL", { Destination: appendWebdavPath(testRootUrl, "chunk-stage.tmp") }); }
  catch (error) {
    if ((await request(sessionUrl, "PROPFIND", { Depth: "0" }).catch(() => null))?.status === 207) acceptanceUploadSession = sessionUrl;
    throw error;
  }
  requireStatus(createSession, [201], "chunk upload v2 session creation failed");
  acceptanceUploadSession = sessionUrl;

  const target = appendWebdavPath(testRootUrl, "chunk-resume payload.bin");
  const totalSize = 10 * MIB + 19;
  const content = new Uint8Array(totalSize);
  for (let index = 0; index < content.byteLength; index += 1) content[index] = (index * 37 + 11) & 0xff;
  const first = content.subarray(0, 5 * MIB);
  const second = content.subarray(5 * MIB);
  const chunkHeaders = { Destination: target, "OC-Total-Length": String(totalSize), "If-None-Match": "*", "Content-Type": "application/octet-stream" };

  requireStatus(await request(appendWebdavPath(sessionUrl, "00001"), "PUT", chunkHeaders, first), [200, 201, 204], "first chunk upload failed");
  const interruptedTarget = await request(target, "PROPFIND", { Depth: "0" });
  requireStatus(interruptedTarget, [404], "partial chunk upload became visible as a target file");
  // Retain the unique session and first chunk across a fresh PROPFIND, then continue with the second chunk.
  const resumedInventory = await request(sessionUrl, "PROPFIND", { Depth: "1" });
  requireStatus(resumedInventory, [207], "chunk session could not be rediscovered after interruption");
  requireStatus(await request(appendWebdavPath(sessionUrl, "00002"), "PUT", chunkHeaders, second), [200, 201, 204], "resumed second chunk upload failed");

  const assembled = await request(appendWebdavPath(sessionUrl, ".file"), "MOVE", {
    Destination: target,
    Overwrite: "F",
    "OC-Total-Length": String(totalSize)
  });
  requireStatus(assembled, [201, 204], "chunk assembly MOVE failed");
  const readback = await request(target, "GET");
  if (readback.bytes.byteLength !== totalSize || await sha256Hex(readback.bytes) !== await sha256Hex(content)) {
    throw new Error("Resumed chunk upload did not match the original bytes.");
  }

  async function request(url: string, method: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<DavReply> {
    const init = acceptanceRequestOptions(auth, method, headers, body, XML_PROPFIND, 60_000);
    const response = await fetch(url, init);
    if (response.status >= 300 && response.status < 400) throw new Error("Nextcloud redirected a chunk acceptance request; redirects are rejected.");
    const bytes = await readBounded(response);
    return { status: response.status, headers: response.headers, bytes, text: new TextDecoder().decode(bytes) };
  }
}

let acceptanceUploadSession: string | null = null;
function requireStatus(reply: DavReply, allowed: readonly number[], message: string): void {
  if (!allowed.includes(reply.status)) throw new Error(`${message} (HTTP ${reply.status}).`);
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Nextcloud acceptance response exceeds the 16 MiB read limit.");
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Nextcloud acceptance response exceeds the 16 MiB read limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

void main().catch((error: unknown) => {
  // Do not dump request headers or the environment: acceptance secrets must stay private.
  console.error("Live Nextcloud acceptance: FAIL", error instanceof Error ? error.message : "Unknown failure.");
  if (acceptanceUploadSession) console.error("A unique upload test session may need removal; its path is intentionally omitted.");
  process.exitCode = 1;
});
