import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, defaultRemoteFolder, normalizeSettings } from "../src/state/settings";

describe("scope and safety settings", () => {
  it("defaults new installations to confirm-over-20 deletes, unpaused, no rules, device size limit", () => {
    const settings = normalizeSettings({});
    expect(settings.deleteConfirmThreshold).toBe(20);
    expect(settings.syncPaused).toBe(false);
    expect(settings.excludePatterns).toEqual([]);
    expect(settings.includeFolders).toEqual([]);
    expect(settings.maxFileSizeMiB).toBe(0);
    expect(settings.autoSyncAllowDeletes).toBe(DEFAULT_SETTINGS.autoSyncAllowDeletes);
  });

  it("keeps a v8 installation's choices and adds the new fields", () => {
    const settings = normalizeSettings({ schemaVersion: 8, autonomyDefaultsVersion: 1, autoSyncEnabled: false, autoSyncAllowDeletes: false, autoSyncQuietSeconds: 30, serverUrl: "https://c.example" });
    expect(settings.autoSyncEnabled).toBe(false);
    expect(settings.autoSyncAllowDeletes).toBe(false);
    expect(settings.autoSyncQuietSeconds).toBe(30);
    expect(settings.deleteConfirmThreshold).toBe(20);
  });

  it("sanitizes rule lists, numbers and booleans", () => {
    const settings = normalizeSettings({
      excludePatterns: [" *.tmp ", "", 5, "*.tmp", "x".repeat(400), "Private/"],
      includeFolders: "not-an-array",
      maxFileSizeMiB: -4,
      deleteConfirmThreshold: 1e12,
      syncPaused: "yes"
    });
    expect(settings.excludePatterns).toEqual(["*.tmp", "Private/"]);
    expect(settings.includeFolders).toEqual([]);
    expect(settings.maxFileSizeMiB).toBe(0);
    expect(settings.deleteConfirmThreshold).toBe(100_000);
    expect(settings.syncPaused).toBe(false);
  });

  it("caps the number of rules", () => {
    const many = Array.from({ length: 500 }, (_, index) => `rule-${index}`);
    expect(normalizeSettings({ excludePatterns: many }).excludePatterns).toHaveLength(200);
  });

  it("keeps the picker's exclusions canonical and bounded", () => {
    const settings = normalizeSettings({ selectiveExcludes: ["/Projects/", "Projects/NYRA", "../x", 7, "Schule"] });
    expect(settings.selectiveExcludes).toEqual(["Projects", "Schule"]);
    expect(normalizeSettings({ selectiveExcludes: "nope" }).selectiveExcludes).toEqual([]);
  });

  it("suggests one remote folder per vault from a safe name", () => {
    expect(defaultRemoteFolder("Nyra")).toBe("Obsidian/Nyra");
    expect(defaultRemoteFolder("  My: Vault / 2026?  ")).toBe("Obsidian/My Vault 2026");
    expect(defaultRemoteFolder("///")).toBe("Obsidian/Vault");
    expect(defaultRemoteFolder("x".repeat(200)).length).toBeLessThanOrEqual("Obsidian/".length + 64);
  });

  it("turns on everything an autonomous installation needs", () => {
    const fresh = normalizeSettings({});
    expect(fresh).toMatchObject({ autoSyncEnabled: true, autoSyncAllowDeletes: true, fastRemoteCheck: true, autoMergeText: true, syncPaused: false, deleteConfirmThreshold: 20, autoSyncQuietSeconds: 1, autoSyncRemotePollSeconds: 15 });
  });

  it("upgrades installations from before the autonomous defaults exactly once", () => {
    const old = { schemaVersion: 8, remoteRootPath: "Obsidian/Nyra", autoSyncEnabled: false, autoSyncAllowDeletes: false, fastRemoteCheck: false, autoMergeText: false };
    const upgraded = normalizeSettings(old);
    expect(upgraded).toMatchObject({ autoSyncEnabled: true, autoSyncAllowDeletes: true, fastRemoteCheck: true, autoMergeText: true, autonomyDefaultsVersion: 1 });
    // After the upgrade the user's own choices are respected.
    const chosen = normalizeSettings({ ...upgraded, autoSyncAllowDeletes: false, autoSyncEnabled: false });
    expect(chosen).toMatchObject({ autoSyncAllowDeletes: false, autoSyncEnabled: false });
  });
});
