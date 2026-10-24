import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import type { HttpRequest, HttpTransport } from "../src/network/http-client";
import { RemoteTransactionalMutator, distinctUploadMtimeMs } from "../src/execution/remote-mutator";
import { TransferJournalStore } from "../src/transfer/journal";
import type { TransferJournalPayload } from "../src/transfer/types";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";
import { makeMemoryVault } from "./helpers/memory-vault";

const serverUrl = "https://cloud.example.test";
const userId = "alice";
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeMutator(dav: HttpTransport): RemoteTransactionalMutator {
  const journal = makeJournal();
  return makeMutatorWithJournal(dav, journal);
}

function makeJournal(): TransferJournalStore {
  return new TransferJournalStore(makeMemoryVault(), "nyra-nextcloud-sync", logger, "c".repeat(32));
}

function makeMutatorWithJournal(dav: HttpTransport, journal: TransferJournalStore): RemoteTransactionalMutator {
  return new RemoteTransactionalMutator(dav, { serverUrl, loginName: userId, appPassword: "test-secret" }, logger, {
    serverUrl, userId, webdavUserRoot: `${serverUrl}/remote.php/dav/files/${userId}/`, journal,
    tuning: { chunkUploadThresholdBytes: 5 * 1024 * 1024, uploadChunkBytes: 5 * 1024 * 1024, downloadRangeChunkBytes: 1024 * 1024, maxWholeDownloadBytes: 5 * 1024 * 1024 },
    maxAttempts: 1
  });
}

describe("live conditional-write capability fence", () => {
  it("accepts a server that advances ETags and rejects stale writes, then removes its unique probe", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    await expect(makeMutator(dav).verifyConditionalWrites()).resolves.toBeUndefined();
    expect(dav.fileUrls()).toEqual([]);
  });

  it("blocks a server that reuses an ETag after an immediate content update", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    dav.reuseEtagOnNextUpdate = true;
    await expect(makeMutator(dav).verifyConditionalWrites()).rejects.toThrow(/did not advance the ETag/);
    expect(dav.fileUrls()).toEqual([]);
  });

  it("accepts real Nextcloud behavior where the ETag only follows the stored mtime", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    dav.etagFollowsMtime = true;
    await expect(makeMutator(dav).verifyConditionalWrites("Obsidian")).resolves.toBeUndefined();
    expect(dav.fileUrls()).toEqual([]);
  });

  it("sends every conditional probe update with an mtime that differs from the stored one", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    dav.etagFollowsMtime = true;
    const updateMtimes: number[] = [];
    const transport: HttpTransport = { request: async (input) => {
      const reply = await dav.request(input);
      if (input.method === "PUT" && input.headers?.["If-Match"] && input.headers["X-OC-MTime"] && reply.status !== 412) updateMtimes.push(Number(input.headers["X-OC-MTime"]));
      return reply;
    } };
    await makeMutator(transport).verifyConditionalWrites();
    expect(updateMtimes.length >= 3).toBe(true);
    for (let index = 1; index < updateMtimes.length; index += 1) expect(updateMtimes[index]).not.toBe(updateMtimes[index - 1]);
    expect(dav.fileUrls()).toEqual([]);
  });

  it("advances the ETag of a real update whose source mtime equals the stored remote mtime", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    dav.etagFollowsMtime = true;
    const mutator = makeMutator(dav);
    const root = `${serverUrl}/remote.php/dav/files/${userId}/`;
    await dav.request({ url: root, method: "MKCOL" } as HttpRequest);
    const url = `${root}note.md`;
    const sourceMtimeMs = 1_700_000_000_000;
    const created = await mutator.uploadCreate(url, "note.md", new TextEncoder().encode("aaaa").buffer, sourceMtimeMs);
    const updated = await mutator.uploadUpdate(url, "note.md", new TextEncoder().encode("bbbb").buffer, created.remote.fileId, created.remote.etag, sourceMtimeMs);
    expect(updated.remote.etag).not.toBe(created.remote.etag);
    expect(updated.remote.fileId).toBe(created.remote.fileId);
  });

  it("only moves an upload mtime when it would collide with the stored remote second", () => {
    expect(distinctUploadMtimeMs(1_700_000_000_400, 1_700_000_000_900)).toBe(1_700_000_001_000);
    expect(distinctUploadMtimeMs(1_700_000_005_000, 1_700_000_000_000)).toBe(1_700_000_005_000);
    expect(distinctUploadMtimeMs(1_700_000_005_500, null)).toBe(1_700_000_005_500);
    expect(distinctUploadMtimeMs(null, null)).toBeNull();
    expect(distinctUploadMtimeMs(null, 1_000)).not.toBeNull();
  });

  it("blocks ignored stale DELETE and MOVE preconditions and cleans both possible probe locations", async () => {
    for (const method of ["DELETE", "MOVE"]) {
      const dav = new FakeNextcloudDav(serverUrl, userId);
      const transport: HttpTransport = { request: async (input) => {
        if (input.method !== method) return await dav.request(input);
        const request: HttpRequest = { ...input, headers: { ...input.headers } };
        delete request.headers!["If-Match"];
        return await dav.request(request);
      } };
      await expect(makeMutator(transport).verifyConditionalWrites()).rejects.toThrow(new RegExp(`stale If-Match ${method}`));
      expect(dav.fileUrls()).toEqual([]);
    }
  });

  it("checks the selected storage root as well as the transfer staging root", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    let selectedRootProbed = false;
    const transport: HttpTransport = { request: async (input) => {
      if (input.url.includes("/Obsidian/.nyra-nextcloud-sync-runtime/") && input.method === "PUT" && input.headers?.["If-Match"]) {
        selectedRootProbed = true;
        dav.reuseEtagOnNextUpdate = true;
      }
      return await dav.request(input);
    } };
    await expect(makeMutator(transport).verifyConditionalWrites("Obsidian")).rejects.toThrow(/did not advance the ETag/);
    expect(selectedRootProbed).toBe(true);
    expect(dav.fileUrls()).toEqual([]);
  });

  it("validates the selected root before creating any probe", async () => {
    let requests = 0;
    const transport: HttpTransport = { request: async () => { requests++; throw new Error("Unexpected request"); } };
    await expect(makeMutator(transport).verifyConditionalWrites("../outside")).rejects.toThrow(/traversal|segment/i);
    expect(requests).toBe(0);
  });

  it("refuses a remote rename without an exact ETag before issuing a request", async () => {
    let requests = 0;
    const transport: HttpTransport = { request: async () => { requests++; throw new Error("Unexpected request"); } };
    await expect(makeMutator(transport).move("https://cloud.example.test/a", "a", "https://cloud.example.test/b", "b", "123", null)).rejects.toThrow(/requires a fresh ETag/);
    expect(requests).toBe(0);
  });

  it("identifies critical transfer recovery before it can mutate the remote", async () => {
    const dav = new FakeNextcloudDav(serverUrl, userId);
    const journal = makeJournal();
    const mutator = makeMutatorWithJournal(dav, journal);
    const root = `${serverUrl}/remote.php/dav/files/${userId}/`;
    const payload: TransferJournalPayload = {
      version: 1, operationKey: "a".repeat(64), operationId: "b".repeat(24),
      kind: "chunked-update", phase: "prepared", targetPath: "Obsidian/note.md",
      targetUrl: `${root}Obsidian/note.md`, tempPath: "temp.md", tempUrl: `${root}temp.md`,
      backupPath: "backup.md", backupUrl: `${root}backup.md`,
      uploadId: `nyra-${"d".repeat(24)}`, uploadUrl: `${serverUrl}/remote.php/dav/uploads/${userId}/nyra-${"d".repeat(24)}/`,
      sourceHash: "e".repeat(64), sourceSize: 1, chunkSize: 1, chunkCount: 1,
      uploadedChunks: [], expectedTargetFileId: null, expectedTargetEtag: null,
      tempFileId: null, tempEtag: null, backupFileId: null, backupEtag: null,
      createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z"
    };
    const prepared = await journal.create(payload);
    expect(await mutator.hasCriticalRecovery()).toBe(false);
    await journal.append(prepared, { phase: "backup-moving" });
    expect(await mutator.hasCriticalRecovery()).toBe(true);
    expect(dav.fileUrls()).toEqual([]);
  });
});
