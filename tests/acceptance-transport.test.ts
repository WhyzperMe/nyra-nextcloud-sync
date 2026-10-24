import { describe, expect, it } from "vitest";
import { acceptanceRequestOptions } from "../e2e/acceptance-request";

describe("Live acceptance transport fidelity", () => {
  it("preserves production PROPFIND properties instead of replacing its XML body", () => {
    const body = new TextEncoder().encode('<propfind><getlastmodified/><checksums/></propfind>');
    const options = acceptanceRequestOptions("Basic fixture", "PROPFIND", { Depth: "0" }, body, "fallback", 30_000);
    expect(options.body).toBe(body);
    expect(new Headers(options.headers).get("Depth")).toBe("0");
    expect(new Headers(options.headers).get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(options.redirect).toBe("manual");
  });

  it("uses the bounded default property set only when the caller omitted a PROPFIND body", () => {
    expect(acceptanceRequestOptions("Basic fixture", "PROPFIND", {}, undefined, "fallback", 30_000).body).toBe("fallback");
  });

  it("preserves conditional mutation headers and does not manufacture a GET body", () => {
    const body = new TextEncoder().encode("fixture");
    const put = acceptanceRequestOptions("Basic fixture", "PUT", { "If-Match": '"old"', "X-OC-MTime": "123" }, body, "fallback", 30_000);
    expect(put.body).toBe(body);
    expect(new Headers(put.headers).get("If-Match")).toBe('"old"');
    expect(new Headers(put.headers).get("X-OC-MTime")).toBe("123");
    expect(acceptanceRequestOptions("Basic fixture", "GET", {}, undefined, "fallback", 30_000).body).toBeUndefined();
  });
});
