import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { CredentialStore } from "../src/auth/credential-store";
import { loadAndMigrateSettings } from "../src/state/settings-migration";

class FakeSecretStorage {
  readonly values = new Map<string, string>();

  getSecret(key: string): string | null {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error("Secret ID is invalid. Use only lowercase letters, numbers and dashes. 64 characters max.");
    return this.values.get(key) ?? null;
  }

  setSecret(key: string, value: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error("Secret ID is invalid. Use only lowercase letters, numbers and dashes. 64 characters max.");
    this.values.set(key, value);
  }
}

describe("credential settings migration", () => {
  it("moves the fixed secret into a unique Stage 2 slot", async () => {
    const secrets = new FakeSecretStorage();
    secrets.setSecret("nyra-nextcloud-sync-app-password-v1", "legacy-secret");
    const store = new CredentialStore({ secretStorage: secrets } as unknown as App);
    const raw = {
      schemaVersion: 1,
      serverUrl: "https://cloud.example.com",
      connectionState: "verified",
      account: {
        serverUrl: "https://cloud.example.com",
        loginName: "dennis",
        userId: "dennis",
        displayName: "Dennis",
        webdavRootUrl: "https://cloud.example.com/remote.php/dav/files/dennis/",
        serverVersion: "32.0.0",
        serverVersionString: "32.0.0",
        verifiedAt: new Date().toISOString()
      },
      pendingLoginName: null,
      lastError: null
    };

    let persisted: unknown = null;
    const settings = await loadAndMigrateSettings(raw, store, async (next) => {
      persisted = structuredClone(next);
    });

    expect(settings.credentialBinding?.serverUrl).toBe("https://cloud.example.com");
    expect(settings.credentialBinding?.loginName).toBe("dennis");
    expect(settings.credentialBinding?.secretId).toMatch(/^nyra-nextcloud-[a-f0-9]{32}$/);
    expect(store.getAppPassword(settings.credentialBinding!.secretId)).toBe("legacy-secret");
    expect(store.getLegacyAppPassword()).toBeNull();
    expect(persisted).toEqual(settings);
  });

  it("does not clear the legacy secret if settings persistence fails", async () => {
    const secrets = new FakeSecretStorage();
    secrets.setSecret("nyra-nextcloud-sync-app-password-v1", "legacy-secret");
    const store = new CredentialStore({ secretStorage: secrets } as unknown as App);
    const raw = {
      schemaVersion: 1,
      serverUrl: "https://cloud.example.com",
      connectionState: "pending-verification",
      account: null,
      pendingLoginName: "dennis",
      lastError: null
    };

    await expect(
      loadAndMigrateSettings(raw, store, async () => {
        throw new Error("disk full");
      })
    ).rejects.toThrow(/disk full/);

    expect(store.getLegacyAppPassword()).toBe("legacy-secret");
  });

  it("fails closed on an invalid pre-fix credential reference without querying it", async () => {
    const secrets = new FakeSecretStorage();
    const store = new CredentialStore({ secretStorage: secrets } as unknown as App);
    const raw = {
      schemaVersion: 8,
      serverUrl: "https://cloud.example.com",
      connectionState: "verified",
      account: {
        serverUrl: "https://cloud.example.com",
        loginName: "dennis",
        userId: "dennis",
        displayName: "Dennis",
        webdavRootUrl: "https://cloud.example.com/remote.php/dav/files/dennis/",
        serverVersion: "32.0.0",
        serverVersionString: "32.0.0",
        verifiedAt: new Date().toISOString()
      },
      credentialBinding: {
        serverUrl: "https://cloud.example.com",
        loginName: "dennis",
        secretId: `cred_${"a".repeat(32)}`
      }
    };
    let persisted: unknown = null;

    const settings = await loadAndMigrateSettings(raw, store, async (next) => {
      persisted = structuredClone(next);
    });

    expect(settings.connectionState).toBe("disconnected");
    expect(settings.credentialBinding).toBeNull();
    expect(settings.lastError).toMatch(/credentials are unavailable/i);
    expect(persisted).toEqual(settings);
  });
});
