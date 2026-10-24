import { describe, expect, it } from "vitest";
import { NextcloudDavClient } from "../src/remote/dav-client";
import type { Logger } from "../src/diagnostics/logger";
import type { HttpTransport } from "../src/network/http-client";
import { assertSameOrigin, appendServerPath, normalizeServerUrl, parseNextcloudLocation } from "../src/security/url-policy";

 describe("server URL policy", () => {
  it("normalizes a Nextcloud base URL", () => {
    expect(normalizeServerUrl(" https://cloud.example.com/nextcloud/ ")).toBe(
      "https://cloud.example.com/nextcloud"
    );
  });

  it("reduces pasted Nextcloud WebDAV file URLs to the server base while preserving an install prefix", () => {
    expect(normalizeServerUrl("https://cloud.example.com/nextcloud/remote.php/dav/files/alice/Obsidian?dir=%2FNotes#view"))
      .toBe("https://cloud.example.com/nextcloud");
  });

  it("reduces pasted Nextcloud Files browser URLs to the server base", () => {
    expect(normalizeServerUrl("https://cloud.example.com/nextcloud/index.php/apps/files/files/123?dir=%2FObsidian"))
      .toBe("https://cloud.example.com/nextcloud");
  });

  it("selects the exact folder from Nextcloud Files and WebDAV links", () => {
    expect(parseNextcloudLocation("https://cloud.example.com/index.php/apps/files/files/322636?dir=%2FObsidian%2FNyra"))
      .toEqual({ serverUrl: "https://cloud.example.com", remoteRootPath: "Obsidian/Nyra" });
    expect(parseNextcloudLocation("https://cloud.example.com/nextcloud/remote.php/dav/files/alice/Obsidian/Nyra/"))
      .toEqual({ serverUrl: "https://cloud.example.com/nextcloud", remoteRootPath: "Obsidian/Nyra" });
  });

  it("does not guess a folder from a bare server URL or unsafe DAV link", () => {
    expect(parseNextcloudLocation("https://cloud.example.com").remoteRootPath).toBeNull();
    expect(() => parseNextcloudLocation("https://cloud.example.com/remote.php/dav/files/alice/Obsidian/%2Fsecret"))
      .toThrow(/unsafe path/);
    expect(() => parseNextcloudLocation("https://cloud.example.com/index.php/apps/files/files/1?dir=%2FA&dir=%2FB"))
      .toThrow(/multiple/);
    expect(() => parseNextcloudLocation("https://alice:password@cloud.example.com/remote.php/dav/files/alice/Obsidian"))
      .toThrow(/credentials/);
  });

  it("rejects remote HTTP", () => {
    expect(() => normalizeServerUrl("http://cloud.example.com")).toThrow(/HTTPS is required/);
  });

  it("allows loopback HTTP for development", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8080/nextcloud")).toBe(
      "http://127.0.0.1:8080/nextcloud"
    );
  });

  it("pins login URLs to the configured origin", () => {
    expect(() =>
      assertSameOrigin(
        "https://cloud.example.com",
        "https://evil.example.net/login",
        "cross-origin-login-url"
      )
    ).toThrow(/different origin/);
  });

  it("preserves a subdirectory base path when constructing endpoints", () => {
    expect(appendServerPath("https://cloud.example.com/nextcloud", "status.php")).toBe(
      "https://cloud.example.com/nextcloud/status.php"
    );
  });

  it("blocks authenticated WebDAV requests outside the verified origin", async () => {
    const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = new NextcloudDavClient(
      { request: async () => { throw new Error("Transport must not be called."); } } as HttpTransport,
      { serverUrl: "https://cloud.example.com", loginName: "alice", appPassword: "secret" },
      logger
    );
    await expect(client.listDirectory("https://attacker.example/dav/"))
      .rejects.toThrow(/different origin/i);
  });
});
