import type { App } from "obsidian";

const LEGACY_APP_PASSWORD_SECRET_KEY = "nyra-nextcloud-sync-app-password-v1";
const SECRET_ID = /^nyra-nextcloud-[a-f0-9]{32}$/;

/**
 * SecretStorage adapter with immutable credential slots.
 *
 * Each login gets a new random slot instead of overwriting one global secret.
 * That prevents a settings-write failure from pairing a new server's password
 * with an old server binding.
 */
export class CredentialStore {
  constructor(private readonly app: App) {}

  getAppPassword(secretId: string): string | null {
    assertSecretId(secretId);
    const value = this.app.secretStorage.getSecret(secretKey(secretId));
    return value && value.length > 0 ? value : null;
  }

  storeNewAppPassword(value: string): string {
    if (!value) throw new Error("Refusing to store an empty app password.");
    const secretId = createSecretId();
    const key = secretKey(secretId);
    this.app.secretStorage.setSecret(key, value);
    if (this.app.secretStorage.getSecret(key) !== value) {
      throw new Error("SecretStorage did not confirm the newly stored app password.");
    }
    return secretId;
  }

  clear(secretId: string): void {
    assertSecretId(secretId);
    const key = secretKey(secretId);
    this.app.secretStorage.setSecret(key, "");
    const remaining = this.app.secretStorage.getSecret(key);
    if (remaining) throw new Error("SecretStorage did not clear the app password.");
  }

  getLegacyAppPassword(): string | null {
    const value = this.app.secretStorage.getSecret(LEGACY_APP_PASSWORD_SECRET_KEY);
    return value && value.length > 0 ? value : null;
  }

  clearLegacy(): void {
    this.app.secretStorage.setSecret(LEGACY_APP_PASSWORD_SECRET_KEY, "");
    const remaining = this.app.secretStorage.getSecret(LEGACY_APP_PASSWORD_SECRET_KEY);
    if (remaining) throw new Error("SecretStorage did not clear the legacy app password.");
  }
}

function secretKey(secretId: string): string {
  assertSecretId(secretId);
  return secretId;
}

function createSecretId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `nyra-nextcloud-${hex}`;
}

function assertSecretId(value: string): void {
  if (!SECRET_ID.test(value)) throw new Error("Invalid credential secret reference.");
}
