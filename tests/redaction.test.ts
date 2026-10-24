import { describe, expect, it } from "vitest";
import { redact, safeUrlForLog } from "../src/security/redaction";

describe("diagnostic redaction", () => {
  it("redacts credential-bearing keys recursively", () => {
    expect(
      redact({
        Authorization: "Basic abc",
        nested: { appPassword: "secret", token: "poll-token", safe: "ok" }
      })
    ).toEqual({
      Authorization: "[REDACTED]",
      nested: { appPassword: "[REDACTED]", token: "[REDACTED]", safe: "ok" }
    });
  });

  it("redacts account, file identity and path metadata from structured logs", () => {
    expect(redact({
      loginName: "alice",
      userId: "alice-id",
      remoteRootPath: "Private Vault",
      targetPath: "Notes/Secret.md",
      fileId: "42",
      etag: "etag-value",
      contentHash: "sha256-value",
      fingerprint: "plan-fingerprint",
      checksum: "private-checksum",
      operationKey: "transfer-operation-key",
      operationId: "op_123"
    })).toEqual({
      loginName: "[REDACTED]",
      userId: "[REDACTED]",
      remoteRootPath: "[REDACTED]",
      targetPath: "[REDACTED]",
      fileId: "[REDACTED]",
      etag: "[REDACTED]",
      contentHash: "[REDACTED]",
      fingerprint: "[REDACTED]",
      checksum: "[REDACTED]",
      operationKey: "[REDACTED]",
      operationId: "op_123"
    });
  });

  it("keeps only the origin for URL fields and omits error text that may contain private data", () => {
    const url = "https://cloud.example.com/remote.php/dav/files/alice/Private.md?token=secret#x";
    expect(safeUrlForLog(url)).toBe("https://cloud.example.com");
    expect(redact({ url, error: `Request failed at ${url}.` })).toEqual({
      url: "https://cloud.example.com",
      error: "[REDACTED]"
    });
  });

  it("redacts free-text diagnostics and unkeyed strings inside arrays", () => {
    expect(redact({
      lastError: "ENOENT: open 'Journal/Personal.md'",
      message: "Merge failed for private note content",
      issues: [{ code: "baseline-missing", message: "Private note.md has a missing BASE" }],
      values: ["Private note.md", { path: "Private note.md" }]
    })).toEqual({
      lastError: "[REDACTED]",
      message: "[REDACTED]",
      issues: [{ code: "baseline-missing", message: "[REDACTED]" }],
      values: ["[REDACTED]", { path: "[REDACTED]" }]
    });
    expect(redact("Private note.md")).toBe("[REDACTED]");
  });

  it("rejects non-HTTP values from URL log fields", () => {
    expect(safeUrlForLog("javascript:alert(1)")).toBe("[invalid-url]");
  });
});
