import { describe, expect, it } from "vitest";
import { diffLines, foldContext, splitLines } from "../src/merge/line-diff";
import { NextcloudVersions } from "../src/recovery/file-versions";
import type { HttpTransport } from "../src/network/http-client";

const apply = (diff: ReturnType<typeof diffLines>): { before: string[]; after: string[] } => ({
  before: diff.lines.filter((line) => line.kind !== "add").map((line) => line.text),
  after: diff.lines.filter((line) => line.kind !== "remove").map((line) => line.text)
});

describe("line diff", () => {
  it("reproduces both inputs from the edit script for assorted edits", () => {
    const cases: Array<[string[], string[]]> = [
      [[], []], [["a"], []], [[], ["a"]], [["a", "b", "c"], ["a", "b", "c"]],
      [["a", "b", "c"], ["a", "x", "c"]], [["a", "b", "c", "d"], ["b", "d", "e"]],
      [["1", "2", "3", "4", "5", "6"], ["0", "1", "3", "4", "6", "7"]],
      [["x", "x", "x"], ["x", "x"]], [["a", "a", "b"], ["b", "a", "a"]]
    ];
    for (const [before, after] of cases) {
      const diff = diffLines(before, after);
      expect(diff.complete).toBe(true);
      expect(apply(diff)).toEqual({ before, after });
    }
  });

  it("reports minimal counts and survives randomized inputs", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toMatchObject({ added: 1, removed: 1 });
    let seed = 12345;
    const random = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 200; round += 1) {
      const before = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
      const after = Array.from({ length: Math.floor(random() * 30) }, () => String(Math.floor(random() * 6)));
      expect(apply(diffLines(before, after))).toEqual({ before, after });
    }
  });

  it("stays bounded for unrelated large files", () => {
    const before = Array.from({ length: 6000 }, (_, i) => `a${i}`);
    const after = Array.from({ length: 6000 }, (_, i) => `b${i}`);
    const diff = diffLines(before, after);
    expect(diff.complete).toBe(false);
    expect(diff.removed).toBe(6000);
  });

  it("folds unchanged context and splits line endings", () => {
    const lines = diffLines(Array.from({ length: 20 }, (_, i) => `l${i}`), Array.from({ length: 20 }, (_, i) => (i === 10 ? "changed" : `l${i}`))).lines;
    const folded = foldContext(lines, 2);
    expect(folded[0]).toEqual({ kind: "skip", count: 8 });
    expect(folded.filter((entry) => entry.kind === "add" || entry.kind === "remove")).toHaveLength(2);
    expect(splitLines("a\r\nb\nc\n")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("Nextcloud versions client", () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/remote.php/dav/versions/u/versions/55/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/versions/u/versions/55/1792597108</d:href><d:propstat><d:prop><d:getlastmodified>Wed, 21 Oct 2026 15:38:28 GMT</d:getlastmodified><d:getcontentlength>11</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/versions/u/versions/55/1792597113</d:href><d:propstat><d:prop><d:getlastmodified>Wed, 21 Oct 2026 15:38:33 GMT</d:getlastmodified><d:getcontentlength>13</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const http: HttpTransport = { async request(request) {
    if (request.method === "GET") return { status: 200, headers: {}, text: "", arrayBuffer: new TextEncoder().encode("old text").buffer as ArrayBuffer, json: () => ({}) };
    return { status: request.url.includes("/missing/") ? 404 : 207, headers: {}, text: xml, arrayBuffer: new ArrayBuffer(0), json: () => ({}) };
  } };
  const client = new NextcloudVersions(http, "https://c.example", "u", "Basic x");

  it("lists versions newest first and downloads one", async () => {
    const versions = await client.list("55");
    expect(versions.map((version) => version.id)).toEqual(["1792597113", "1792597108"]);
    expect(versions[1]).toMatchObject({ size: 11, modifiedAt: "2026-10-21T15:38:28.000Z" });
    expect(new TextDecoder().decode(await client.download("55", versions[0]!))).toBe("old text");
  });

  it("rejects hostile ids and oversized versions", async () => {
    await expect(client.list("../x")).rejects.toThrow(/Invalid/);
    await expect(client.download("55", { id: "1", size: 64 * 1024 * 1024, modifiedAt: "2026-01-01T00:00:00Z" })).rejects.toThrow(/larger than/);
  });
});
