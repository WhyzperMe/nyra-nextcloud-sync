import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
const replies: Array<{ status: number; text: string }> = [];
vi.mock("obsidian", () => ({
  requestUrl: vi.fn(async (params: { url: string; method?: string; headers?: Record<string, string> }) => {
    calls.push(params);
    const reply = replies.shift() ?? { status: 200, text: "" };
    return { status: reply.status, text: reply.text, headers: {}, arrayBuffer: new ArrayBuffer(0) };
  })
}));

const { HttpClient } = await import("../src/network/http-client");
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const sabre = "<s:message>An If-None-Match header was specified, but the ETag matched (or * was specified).</s:message>";
const url = "https://cloud.example.test/remote.php/dav/files/alice/Note.md";

describe("HttpClient cache safety", () => {
  beforeEach(() => { calls.length = 0; replies.length = 0; });

  it("reads through a unique URL so no cache entry can later be validated by a write", async () => {
    await new HttpClient(logger).request({ url, method: "GET" });
    await new HttpClient(logger).request({ url });
    expect(calls.length).toBe(2);
    for (const call of calls) expect(new URL(call.url).searchParams.get("nyra_nc")).toBeTruthy();
    expect(new URL(calls[0]!.url).search).not.toBe(new URL(calls[1]!.url).search);
  });

  it("leaves writes on their exact URL", async () => {
    await new HttpClient(logger).request({ url, method: "PUT", headers: { "If-Match": "\"a\"" } });
    expect(calls[0]!.url).toBe(url);
  });

  it("repeats a write once on a fresh URL when a 412 names an If-None-Match the request never sent", async () => {
    replies.push({ status: 412, text: sabre }, { status: 201, text: "" });
    const response = await new HttpClient(logger).request({ url, method: "MOVE", headers: { Destination: "x", "If-Match": "\"a\"" } });
    expect(response.status).toBe(201);
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toBe(url);
    expect(new URL(calls[1]!.url).searchParams.get("nyra_nc")).toBeTruthy();
    expect(calls[1]!.headers?.Destination).toBe("x");
  });

  it("does not repeat an ordinary 412, a create-only PUT or a second refusal", async () => {
    replies.push({ status: 412, text: "<s:message>The If-Match header did not match.</s:message>" });
    expect((await new HttpClient(logger).request({ url, method: "PUT", headers: { "If-Match": "\"a\"" } })).status).toBe(412);
    expect(calls.length).toBe(1);

    calls.length = 0; replies.push({ status: 412, text: sabre });
    expect((await new HttpClient(logger).request({ url, method: "PUT", headers: { "If-None-Match": "*" } })).status).toBe(412);
    expect(calls.length).toBe(1);

    calls.length = 0; replies.push({ status: 412, text: sabre }, { status: 412, text: sabre });
    expect((await new HttpClient(logger).request({ url, method: "DELETE", headers: { "If-Match": "\"a\"" } })).status).toBe(412);
    expect(calls.length).toBe(2);
  });
});
