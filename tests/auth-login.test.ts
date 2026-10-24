import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { AuthController, type SettingsPort } from "../src/auth/auth-controller";
import { CredentialStore } from "../src/auth/credential-store";
import type { Logger } from "../src/diagnostics/logger";
import type { VerificationReport } from "../src/core/types";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/state/settings";
import type { ConnectionVerifier } from "../src/nextcloud/verification";
import type { LoginFlowV2 } from "../src/auth/login-flow-v2";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const server = "https://cloud.example.com";
const account = {
  serverUrl: server,
  loginName: "alice",
  userId: "alice",
  displayName: "Alice",
  webdavRootUrl: `${server}/remote.php/dav/files/alice/`,
  serverVersion: "35.0.0.0",
  serverVersionString: "35.0.0",
  verifiedAt: "2026-09-27T00:00:00.000Z"
};
const report: VerificationReport = {
  account,
  capabilities: {},
  status: { installed: true, maintenance: false, needsDbUpgrade: false, version: "35.0.0.0", versionString: "35.0.0", productName: "Nextcloud" }
};

class FakeSecretStorage {
  readonly values = new Map<string, string>();
  getSecret(key: string): string | null { return this.values.get(key) ?? null; }
  setSecret(key: string, value: string): void {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error("Secret ID is invalid. Use only lowercase letters, numbers and dashes. 64 characters max.");
    this.values.set(key, value);
  }
}

function createHarness(options: { begin?: () => Promise<void>; openLink?: () => Promise<void>; verify?: () => Promise<void>; verifyStarted?: () => void; unsafeWebdavRoot?: string; unsafeLoginUrl?: string; sessionLifetimeMs?: number; failVerify?: boolean } = {}) {
  const secrets = new FakeSecretStorage();
  const credentials = new CredentialStore({ secretStorage: secrets } as unknown as App);
  let settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  const events: string[] = [];
  const settingsPort: SettingsPort = {
    read: () => settings,
    update: async (mutator) => {
      events.push("persist");
      const next = structuredClone(settings);
      mutator(next);
      settings = next;
    }
  };
  const loginFlow = {
    begin: async (serverUrl: string) => {
      events.push("begin");
      await options.begin?.();
      return { trustedServerUrl: serverUrl, loginUrl: options.unsafeLoginUrl ?? `${serverUrl}/login`, pollEndpoint: `${serverUrl}/poll`, pollToken: "poll-token", expiresAt: Date.now() + (options.sessionLifetimeMs ?? 60_000) };
    },
    poll: async () => { events.push("poll"); return { serverUrl: server, loginName: "alice", appPassword: "generated-app-password" }; }
  } as unknown as LoginFlowV2;
  const verifier = {
    verify: async () => {
      events.push("verify");
      options.verifyStarted?.();
      await options.verify?.();
      if (options.failVerify) throw new Error("server verification unavailable");
      return { ...report, account: { ...account, webdavRootUrl: options.unsafeWebdavRoot ?? account.webdavRootUrl } };
    }
  } as unknown as ConnectionVerifier;
  const auth = new AuthController(loginFlow, verifier, credentials, settingsPort, logger);
  return {
    auth,
    loginWithBrowser: (serverUrl = server) => auth.loginWithBrowser(serverUrl, async (url) => {
      events.push("open-link");
      expect(url).toBe(`${server}/login`);
      await options.openLink?.();
    }),
    credentials,
    secrets,
    events,
    get settings() { return settings; },
    set settings(value: PluginSettings) { settings = value; }
  };
}

describe("browser login and credential safety", () => {
  it("prepares the safe browser link ahead of the click and completes login without a second link action", async () => {
    const h = createHarness();
    h.settings = { ...h.settings, serverUrl: server };

    const loginUrl = await h.auth.prepareBrowserLogin(server);
    expect(loginUrl).toBe(`${server}/login`);
    expect(h.auth.getPreparedBrowserLoginUrl(server)).toBe(loginUrl);
    expect(h.events).toEqual(["begin"]);
    expect(h.settings.connectionState).toBe("disconnected");
    expect(h.secrets.values.size).toBe(0);

    const verified = await h.auth.loginWithPreparedBrowser(server);

    expect(verified.account.loginName).toBe("alice");
    expect(h.events).toEqual(["begin", "persist", "poll", "persist", "verify", "persist"]);
    expect(h.auth.getPreparedBrowserLoginUrl(server)).toBeNull();
    expect(h.settings.credentialBinding?.secretId).toMatch(/^nyra-nextcloud-[a-f0-9]{32}$/);
    expect(h.auth.getVerifiedCredentials().appPassword).toBe("generated-app-password");
  });

  it("does not publish a prepared link when the configured server changes during preparation", async () => {
    let releaseBegin!: () => void;
    let markBeginStarted!: () => void;
    const beginStarted = new Promise<void>((resolve) => { markBeginStarted = resolve; });
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const h = createHarness({ begin: async () => { markBeginStarted(); await beginGate; } });
    h.settings = { ...h.settings, serverUrl: server };
    const preparation = h.auth.prepareBrowserLogin(server);
    await beginStarted;
    h.settings = { ...h.settings, serverUrl: "https://other.example" };
    releaseBegin();

    await expect(preparation).rejects.toThrow(/selected server changed/i);
    expect(h.auth.getPreparedBrowserLoginUrl(server)).toBeNull();
  });

  it("invalidates a ready browser link after the configured server changes", async () => {
    const h = createHarness();
    h.settings = { ...h.settings, serverUrl: server };
    await h.auth.prepareBrowserLogin(server);
    h.settings = { ...h.settings, serverUrl: "https://other.example" };

    expect(h.auth.getPreparedBrowserLoginUrl(server)).toBeNull();
    expect(() => h.auth.loginWithPreparedBrowser(server)).toThrow(/configured server changed/i);
    expect(h.events).toEqual(["begin"]);
  });

  it("waits for user activation of the trusted external link before polling and stores verified credentials", async () => {
    let openLink!: () => void;
    let markLinkReady!: () => void;
    const linkReady = new Promise<void>((resolve) => { markLinkReady = resolve; });
    const h = createHarness({ openLink: async () => { markLinkReady(); await new Promise<void>((resolve) => { openLink = resolve; }); } });
    const login = h.loginWithBrowser();
    await linkReady;

    expect(h.events).toEqual(["persist", "begin", "open-link"]);
    expect(h.events.includes("poll")).toBe(false);
    openLink();
    const verified = await login;

    expect(verified.account.loginName).toBe("alice");
    expect(h.events).toEqual(["persist", "begin", "open-link", "poll", "persist", "verify", "persist"]);
    expect(h.settings.connectionState).toBe("verified");
    expect(h.settings.credentialBinding !== null).toBe(true);
    expect(h.auth.getVerifiedCredentials().appPassword).toBe("generated-app-password");
    expect(Object.hasOwn(h.settings, "appPassword")).toBe(false);
  });

  it("opens the trusted Login Flow URL and stores then verifies the generated app password", async () => {
    const h = createHarness();
    const login = h.loginWithBrowser();
    const verified = await login;

    expect(verified.account.loginName).toBe("alice");
    expect(h.events).toEqual(["persist", "begin", "open-link", "poll", "persist", "verify", "persist"]);
    expect(h.settings.connectionState).toBe("verified");
    expect(h.settings.credentialBinding !== null).toBe(true);
    expect(h.auth.getVerifiedCredentials().appPassword).toBe("generated-app-password");
    expect(Object.hasOwn(h.settings, "appPassword")).toBe(false);
  });

  it("refuses to send credentials when persisted WebDAV account data points off-origin", () => {
    const h = createHarness();
    const secretId = h.credentials.storeNewAppPassword("secret");
    h.settings = {
      ...DEFAULT_SETTINGS,
      serverUrl: server,
      connectionState: "verified",
      account: { ...account, webdavRootUrl: "https://attacker.example/dav/" },
      credentialBinding: { serverUrl: server, loginName: "alice", secretId }
    };
    expect(() => h.auth.getVerifiedCredentials()).toThrow(/different origin/i);
  });

  it("waits for a cancelled in-flight login before disconnecting", async () => {
    let releaseBegin!: () => void;
    let markBeginStarted!: () => void;
    const beginStarted = new Promise<void>((resolve) => { markBeginStarted = resolve; });
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const h = createHarness({ begin: async () => { markBeginStarted(); await beginGate; } });
    const login = h.loginWithBrowser();
    await beginStarted;
    const disconnect = h.auth.disconnect();
    releaseBegin();
    await disconnect;

    await expect(login).rejects.toThrow(/cancelled/i);
    expect(h.settings.connectionState).toBe("disconnected");
    expect(h.settings.credentialBinding).toBeNull();
    expect(h.events.includes("open-link")).toBe(false);
  });

  it("stops login work on plugin unload, including a pending initialization request", async () => {
    let releaseBegin!: () => void;
    let markBeginStarted!: () => void;
    const beginStarted = new Promise<void>((resolve) => { markBeginStarted = resolve; });
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const h = createHarness({ begin: async () => { markBeginStarted(); await beginGate; } });
    const login = h.loginWithBrowser();
    await beginStarted;

    h.auth.close();
    releaseBegin();

    await expect(login).rejects.toThrow(/cancelled/i);
    expect(h.events.includes("open-link")).toBe(false);
    expect(h.events.includes("poll")).toBe(false);
    expect(h.settings.connectionState).toBe("disconnected");
    expect(() => h.loginWithBrowser()).toThrow(/unloading/i);
  });

  it("ignores credential verification that returns after plugin unload", async () => {
    let releaseVerify!: () => void;
    let markVerifyStarted!: () => void;
    const verifyStarted = new Promise<void>((resolve) => { markVerifyStarted = resolve; });
    const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const h = createHarness({ verify: async () => { markVerifyStarted(); await verifyGate; } });
    const secretId = h.credentials.storeNewAppPassword("verified-secret");
    h.settings = {
      ...DEFAULT_SETTINGS,
      serverUrl: server,
      connectionState: "verified",
      account,
      credentialBinding: { serverUrl: server, loginName: "alice", secretId }
    };
    const verification = h.auth.verifyStoredCredentials();
    await verifyStarted;

    h.auth.close();
    releaseVerify();

    await expect(verification).rejects.toThrow(/changed while its credentials/i);
    expect(h.events).toEqual(["verify"]);
    expect(h.settings.connectionState).toBe("verified");
    expect(h.credentials.getAppPassword(secretId)).toBe("verified-secret");
  });

  it("keeps the old verified credential until a replacement credential has verified", async () => {
    const h = createHarness({ failVerify: true });
    const oldSecretId = h.credentials.storeNewAppPassword("previous-verified-secret");
    h.settings = {
      ...DEFAULT_SETTINGS,
      serverUrl: server,
      connectionState: "verified",
      account,
      credentialBinding: { serverUrl: server, loginName: "alice", secretId: oldSecretId }
    };

    await expect(h.loginWithBrowser()).rejects.toThrow(/verification unavailable/i);
    expect(h.settings.connectionState).toBe("verified");
    expect(h.settings.account?.userId).toBe("alice");
    expect(h.settings.credentialBinding?.secretId).toBe(oldSecretId);
    expect(h.credentials.getAppPassword(oldSecretId)).toBe("previous-verified-secret");
    expect([...h.secrets.values.values()].filter((value) => value.length > 0)).toEqual(["previous-verified-secret"]);
  });

  it("cancels cleanly while waiting for the user to open the external sign-in link", async () => {
    let markLinkReady!: () => void;
    const linkReady = new Promise<void>((resolve) => { markLinkReady = resolve; });
    const neverOpen = new Promise<void>(() => undefined);
    const h = createHarness({ openLink: async () => { markLinkReady(); await neverOpen; } });
    const login = h.loginWithBrowser();
    await linkReady;

    const disconnect = h.auth.disconnect();
    await disconnect;
    await expect(login).rejects.toThrow(/cancelled/i);
    expect(h.events.includes("poll")).toBe(false);
    expect(h.settings.connectionState).toBe("disconnected");
    expect(h.settings.credentialBinding).toBeNull();
  });

  it("rejects an expired sign-in handoff and restores the previous settings", async () => {
    const neverOpen = new Promise<void>(() => undefined);
    const h = createHarness({ openLink: () => neverOpen, sessionLifetimeMs: 5 });

    await expect(h.loginWithBrowser()).rejects.toThrow(/session expired/i);
    expect(h.events.includes("poll")).toBe(false);
    expect(h.settings.connectionState).toBe("disconnected");
    expect(h.settings.credentialBinding).toBeNull();
  });

  it("never exposes a cross-origin Login Flow URL as a clickable link", async () => {
    const h = createHarness({ unsafeLoginUrl: "https://attacker.example/login" });

    await expect(h.loginWithBrowser()).rejects.toThrow(/different origin/i);
    expect(h.events.includes("open-link")).toBe(false);
    expect(h.events.includes("poll")).toBe(false);
    expect(h.settings.connectionState).toBe("disconnected");
  });

  it("does not publish credentials if the configured server changes during login", async () => {
    let releaseBegin!: () => void;
    let markBeginStarted!: () => void;
    const beginStarted = new Promise<void>((resolve) => { markBeginStarted = resolve; });
    const beginGate = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const h = createHarness({ begin: async () => { markBeginStarted(); await beginGate; } });
    const login = h.loginWithBrowser();
    await beginStarted;
    h.settings = { ...h.settings, serverUrl: "https://other.example" };
    releaseBegin();

    await expect(login).rejects.toThrow(/server changed/i);
    expect(h.settings.serverUrl).toBe("https://other.example");
    expect(h.settings.connectionState).toBe("disconnected");
    expect(h.settings.credentialBinding).toBeNull();
    expect([...h.secrets.values.values()]).toEqual([]);
    expect(h.events.includes("open-link")).toBe(false);
  });

  it("does not let a stale verification response replace a newly selected server", async () => {
    let releaseVerify!: () => void;
    let markVerifyStarted!: () => void;
    const verifyStarted = new Promise<void>((resolve) => { markVerifyStarted = resolve; });
    const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const h = createHarness({ verify: async () => { markVerifyStarted(); await verifyGate; } });
    const secretId = h.credentials.storeNewAppPassword("verified-secret");
    h.settings = {
      ...DEFAULT_SETTINGS,
      serverUrl: server,
      connectionState: "verified",
      account,
      credentialBinding: { serverUrl: server, loginName: "alice", secretId }
    };
    const verification = h.auth.verifyStoredCredentials();
    await verifyStarted;
    h.settings = { ...h.settings, serverUrl: "https://other.example" };
    releaseVerify();

    await expect(verification).rejects.toThrow(/changed during verification/i);
    expect(h.settings.serverUrl).toBe("https://other.example");
    expect(h.settings.credentialBinding?.secretId).toBe(secretId);
    expect(h.credentials.getAppPassword(secretId)).toBe("verified-secret");
  });
});
