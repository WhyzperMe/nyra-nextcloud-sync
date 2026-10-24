import type { CredentialStore } from "../auth/credential-store";
import type { Logger } from "../diagnostics/logger";
import {
  inferLegacyCredentialIdentity,
  normalizeSettings,
  type PluginSettings
} from "./settings";

export async function loadAndMigrateSettings(
  raw: unknown,
  credentials: CredentialStore,
  persist: (settings: PluginSettings) => Promise<void>,
  logger?: Logger
): Promise<PluginSettings> {
  let settings = normalizeSettings(raw);

  // Current settings already reference an immutable secret slot.
  if (settings.credentialBinding) {
    if (!credentials.getAppPassword(settings.credentialBinding.secretId)) {
      settings = credentialUnavailable(settings);
      await persist(settings);
    }
    return settings;
  }

  // Early versions used one fixed SecretStorage key. Migrate it transactionally:
  // create a new slot first, persist the reference second, clear legacy last.
  const legacySecret = credentials.getLegacyAppPassword();
  const legacyIdentity = inferLegacyCredentialIdentity(raw);
  if (legacySecret && legacyIdentity) {
    const secretId = credentials.storeNewAppPassword(legacySecret);
    const migrated: PluginSettings = {
      ...settings,
      credentialBinding: {
        serverUrl: legacyIdentity.serverUrl,
        loginName: legacyIdentity.loginName,
        secretId
      }
    };

    try {
      await persist(migrated);
    } catch (error) {
      try {
        credentials.clear(secretId);
      } catch (cleanupError) {
        logger?.warn("auth.migration-new-secret-cleanup-failed", {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        });
      }
      throw error;
    }

    try {
      credentials.clearLegacy();
    } catch (cleanupError) {
      // The durable settings now point at the new immutable slot. A stale
      // legacy slot is unreachable and can be cleaned later; it must not make
      // an otherwise successful migration prevent plugin startup.
      logger?.warn("auth.migration-legacy-secret-cleanup-failed", {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      });
    }
    return migrated;
  }

  if (settings.connectionState === "verified" || settings.connectionState === "pending-verification") {
    settings = credentialUnavailable(settings);
    await persist(settings);
  }
  return settings;
}

function credentialUnavailable(settings: PluginSettings): PluginSettings {
  return {
    ...settings,
    connectionState: "disconnected",
    account: null,
    pendingLoginName: null,
    credentialBinding: null,
    lastError: "Stored Nextcloud credentials are unavailable. Log in with the browser again."
  };
}
