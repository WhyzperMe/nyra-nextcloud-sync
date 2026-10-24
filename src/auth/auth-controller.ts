import { NyraError, errorMessage } from "../core/errors";
import type { NextcloudCredentials, VerificationReport } from "../core/types";
import type { Logger } from "../diagnostics/logger";
import type { ConnectionVerifier } from "../nextcloud/verification";
import { nextcloudEndpoints } from "../nextcloud/endpoints";
import { assertSameOrigin, normalizeServerUrl } from "../security/url-policy";
import type { PluginSettings } from "../state/settings";
import type { CredentialStore } from "./credential-store";
import type { LoginCancellation, LoginFlowSession, LoginFlowV2 } from "./login-flow-v2";

export interface SettingsPort {
  read(): PluginSettings;
  update(mutator: (settings: PluginSettings) => void): Promise<void>;
}

class MutableCancellation implements LoginCancellation {
  cancelled = false;
  readonly whenCancelled: Promise<void>;
  private resolveCancellation!: () => void;

  constructor() {
    this.whenCancelled = new Promise((resolve) => { this.resolveCancellation = resolve; });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.resolveCancellation();
  }
}

export class AuthController {
  private activeCancellation: MutableCancellation | null = null;
  private activeLoginPromise: Promise<VerificationReport> | null = null;
  private preparedLogin: { serverUrl: string; session: LoginFlowSession } | null = null;
  private loginPreparation: { serverUrl: string; promise: Promise<LoginFlowSession> } | null = null;
  private credentialGeneration = 0;
  private closed = false;

  constructor(
    private readonly loginFlow: LoginFlowV2,
    private readonly verifier: ConnectionVerifier,
    private readonly credentials: CredentialStore,
    private readonly settingsPort: SettingsPort,
    private readonly logger: Logger
  ) {}

  isLoginActive(): boolean {
    return this.activeCancellation !== null;
  }

  hasStoredCredentials(): boolean {
    const binding = this.settingsPort.read().credentialBinding;
    return binding !== null && this.credentials.getAppPassword(binding.secretId) !== null;
  }

  getVerifiedCredentials(): NextcloudCredentials {
    const settings = this.settingsPort.read();
    const binding = settings.credentialBinding;
    if (settings.connectionState !== "verified" || !settings.account || !binding) {
      throw new NyraError("missing-credentials", "A verified Nextcloud connection is required.");
    }
    const appPassword = this.credentials.getAppPassword(binding.secretId);
    if (!appPassword) throw new NyraError("missing-credentials", "The stored Nextcloud app password is unavailable.");
    const configuredServer = normalizeServerUrl(settings.serverUrl);
    const boundServer = normalizeServerUrl(binding.serverUrl);
    const accountServer = normalizeServerUrl(settings.account.serverUrl);
    if (configuredServer !== boundServer || configuredServer !== accountServer || settings.account.loginName !== binding.loginName) {
      throw new NyraError("credential-server-mismatch", "The verified account and stored credential binding do not match.");
    }
    const trustedWebdavRoot = assertSameOrigin(configuredServer, settings.account.webdavRootUrl, "cross-origin-credential-server");
    const expectedWebdavRoot = nextcloudEndpoints.webdavUserRoot(configuredServer, settings.account.userId);
    if (new URL(trustedWebdavRoot).toString() !== new URL(expectedWebdavRoot).toString()) {
      throw new NyraError("credential-server-mismatch", "The stored WebDAV root does not match the verified Nextcloud account.");
    }
    return { serverUrl: boundServer, loginName: binding.loginName, appPassword };
  }

  canVerifyStoredCredentials(): boolean {
    const settings = this.settingsPort.read();
    const binding = settings.credentialBinding;
    if (!binding || !this.credentials.getAppPassword(binding.secretId) || !settings.serverUrl) return false;
    try {
      return normalizeServerUrl(settings.serverUrl) === normalizeServerUrl(binding.serverUrl);
    } catch {
      return false;
    }
  }

  cancelLogin(): void {
    this.activeCancellation?.cancel();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.credentialGeneration += 1;
    this.preparedLogin = null;
    this.cancelLogin();
  }

  prepareBrowserLogin(serverInput: string): Promise<string> {
    this.assertOpen();
    if (this.activeCancellation) throw new NyraError("login-cancelled", "A browser login is already running.");
    const serverUrl = normalizeServerUrl(serverInput);
    const ready = this.getPreparedSession(serverUrl);
    if (ready) return Promise.resolve(ready.session.loginUrl);

    if (this.loginPreparation && sameServer(this.loginPreparation.serverUrl, serverUrl)) {
      return this.loginPreparation.promise.then((session) => session.loginUrl);
    }

    const generation = this.credentialGeneration;
    let pending!: Promise<LoginFlowSession>;
    pending = this.loginFlow.begin(serverUrl).then((session) => {
      this.assertOpen();
      if (generation !== this.credentialGeneration || !sameServer(this.settingsPort.read().serverUrl, serverUrl)) {
        throw new NyraError("login-cancelled", "Sign-in preparation stopped because the selected server changed.");
      }
      if (!sameServer(session.trustedServerUrl, serverUrl)) {
        throw new NyraError("credential-server-mismatch", "Nextcloud prepared sign-in for a different server.");
      }
      const trustedSession = {
        ...session,
        trustedServerUrl: serverUrl,
        loginUrl: assertSameOrigin(serverUrl, session.loginUrl, "cross-origin-login-url")
      };
      this.preparedLogin = { serverUrl, session: trustedSession };
      return trustedSession;
    }).finally(() => {
      if (this.loginPreparation?.promise === pending) this.loginPreparation = null;
    });
    this.loginPreparation = { serverUrl, promise: pending };
    return pending.then((session) => session.loginUrl);
  }

  getPreparedBrowserLoginUrl(serverInput: string): string | null {
    try {
      const prepared = this.getPreparedSession(normalizeServerUrl(serverInput));
      return prepared?.session.loginUrl ?? null;
    } catch {
      return null;
    }
  }

  loginWithPreparedBrowser(serverInput: string): Promise<VerificationReport> {
    this.assertOpen();
    const serverUrl = normalizeServerUrl(serverInput);
    if (!sameServer(this.settingsPort.read().serverUrl, serverUrl)) {
      this.preparedLogin = null;
      throw new NyraError("login-cancelled", "Browser sign-in stopped because the configured server changed.");
    }
    const prepared = this.getPreparedSession(serverUrl);
    if (!prepared) {
      throw new NyraError("login-session-not-ready", "The secure sign-in link is not ready yet. Wait a moment and try again.");
    }
    this.preparedLogin = null;
    return this.startBrowserLogin(serverUrl, null, prepared.session);
  }

  loginWithBrowser(serverInput: string, openLoginLink: (url: string) => Promise<void>): Promise<VerificationReport> {
    this.assertOpen();
    const serverUrl = normalizeServerUrl(serverInput);
    return this.startBrowserLogin(serverUrl, openLoginLink, null);
  }

  private startBrowserLogin(
    serverUrl: string,
    openLoginLink: ((url: string) => Promise<void>) | null,
    preparedSession: LoginFlowSession | null
  ): Promise<VerificationReport> {
    if (this.activeCancellation) throw new Error("A browser login is already running.");
    const previousSettings = structuredClone(this.settingsPort.read());
    const cancellation = new MutableCancellation();
    const generation = ++this.credentialGeneration;
    this.preparedLogin = null;
    this.activeCancellation = cancellation;
    const operation = this.completeBrowserLogin(serverUrl, previousSettings, cancellation, openLoginLink, preparedSession, generation);
    let tracked!: Promise<VerificationReport>;
    tracked = operation.finally(() => {
      if (this.activeCancellation === cancellation) this.activeCancellation = null;
      if (this.activeLoginPromise === tracked) this.activeLoginPromise = null;
    });
    this.activeLoginPromise = tracked;
    return tracked;
  }

  private async completeBrowserLogin(
    serverUrl: string,
    previousSettings: PluginSettings,
    cancellation: MutableCancellation,
    openLoginLink: ((url: string) => Promise<void>) | null,
    preparedSession: LoginFlowSession | null,
    generation: number
  ): Promise<VerificationReport> {
    let replacementSecretId: string | null = null;
    let replacementPublished = false;

    try {
      await this.settingsPort.update((settings) => {
        settings.serverUrl = serverUrl;
        settings.connectionState = "authenticating";
        settings.lastError = null;
      });
      this.assertLoginScope(serverUrl, cancellation, generation);

      const session = preparedSession ?? await this.loginFlow.begin(serverUrl);
      this.assertLoginScope(serverUrl, cancellation, generation);
      const loginUrl = assertSameOrigin(serverUrl, session.loginUrl, "cross-origin-login-url");
      if (openLoginLink) {
        let handoffTimeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
          await Promise.race([
            openLoginLink(loginUrl),
            cancellation.whenCancelled.then(() => {
              throw new NyraError("login-cancelled", "Browser login was cancelled.");
            }),
            new Promise<never>((_resolve, reject) => {
              handoffTimeout = globalThis.setTimeout(() => {
                reject(new NyraError("login-timeout", "The sign-in link was not opened before the Nextcloud login session expired."));
              }, Math.max(0, session.expiresAt - Date.now()));
            })
          ]);
        } finally {
          if (handoffTimeout !== null) globalThis.clearTimeout(handoffTimeout);
        }
      }
      if (Date.now() >= session.expiresAt) {
        throw new NyraError("login-timeout", "Nextcloud browser login timed out. Start the login flow again.");
      }
      this.assertLoginScope(serverUrl, cancellation, generation);
      const issued = await this.loginFlow.poll(session, cancellation);
      this.assertLoginScope(serverUrl, cancellation, generation);

      // Never overwrite an existing secret slot in place. A new login gets a
      // new immutable slot first; only then is data.json switched to that slot.
      replacementSecretId = this.credentials.storeNewAppPassword(issued.appPassword);
      try {
        const secretId = replacementSecretId;
        await this.settingsPort.update((settings) => {
          settings.serverUrl = issued.serverUrl;
          settings.pendingLoginName = issued.loginName;
          settings.credentialBinding = {
            serverUrl: issued.serverUrl,
            loginName: issued.loginName,
            secretId
          };
          settings.connectionState = "pending-verification";
          settings.account = null;
          settings.lastError = null;
        });
        replacementPublished = true;
      } catch (error) {
        this.tryClearSecret(replacementSecretId, "auth.new-secret-cleanup-failed");
        replacementSecretId = null;
        throw error;
      }

      const report = await this.verifyStoredCredentials();
      this.assertLoginScope(serverUrl, cancellation, generation);

      // The new binding is now both persisted and verified. Only now is it safe
      // to retire the previous credential slot. A transient verification error
      // therefore cannot destroy a previously working connection.
      const previousBinding = previousSettings.credentialBinding;
      if (previousBinding && previousBinding.secretId !== replacementSecretId) {
        this.tryClearSecret(previousBinding.secretId, "auth.previous-secret-clear-failed");
      }
      return report;
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error("auth.login-failed", { error: message });

      const currentServer = this.settingsPort.read().serverUrl;
      const serverChanged = !sameServer(currentServer, serverUrl);
      let restored = false;
      try {
        await this.restoreSettings(previousSettings, serverChanged);
        restored = true;
      } catch (restoreError) {
        this.logger.error("auth.login-rollback-failed", {
          originalError: message,
          rollbackError: errorMessage(restoreError)
        });
      }

      if (restored && replacementSecretId) {
        this.tryClearSecret(replacementSecretId, "auth.failed-login-secret-cleanup-failed");
      }

      if (!restored) {
        // Keep whichever credential binding is currently durable. If a new
        // binding was published, do not clear its secret because data.json still
        // references it.
        await this.settingsPort.update((settings) => {
          if (error instanceof NyraError && error.code === "login-cancelled" && !replacementPublished) {
            settings.connectionState = settings.credentialBinding ? "pending-verification" : "disconnected";
          } else {
            settings.connectionState = "error";
            settings.lastError = message;
          }
        });
      }
      throw error;
    }
  }

  private assertLoginScope(serverUrl: string, cancellation: MutableCancellation, generation: number): void {
    if (cancellation.cancelled || generation !== this.credentialGeneration) {
      throw new NyraError("login-cancelled", "Browser login was cancelled.");
    }
    if (!sameServer(this.settingsPort.read().serverUrl, serverUrl)) {
      throw new NyraError("login-cancelled", "Browser login stopped because the configured server changed.");
    }
  }

  private async restoreSettings(snapshot: PluginSettings, preserveConfiguredServer = false): Promise<void> {
    await this.settingsPort.update((settings) => {
      const selectedServer = settings.serverUrl;
      settings.schemaVersion = snapshot.schemaVersion;
      settings.serverUrl = preserveConfiguredServer ? selectedServer : snapshot.serverUrl;
      settings.remoteRootPath = snapshot.remoteRootPath;
      settings.remoteDirectoryConcurrency = snapshot.remoteDirectoryConcurrency;
      settings.connectionState = preserveConfiguredServer ? "disconnected" : snapshot.connectionState;
      settings.account = snapshot.account ? structuredClone(snapshot.account) : null;
      settings.pendingLoginName = snapshot.pendingLoginName;
      settings.credentialBinding = snapshot.credentialBinding ? structuredClone(snapshot.credentialBinding) : null;
      settings.lastError = preserveConfiguredServer ? "Browser login stopped because the configured server changed. Log in again to connect to the selected server." : snapshot.lastError;
    });
  }

  private tryClearSecret(secretId: string, event: string): void {
    try {
      this.credentials.clear(secretId);
    } catch (error) {
      this.logger.warn(event, { error: errorMessage(error) });
    }
  }

  async verifyStoredCredentials(): Promise<VerificationReport> {
    this.assertOpen();
    const settings = this.settingsPort.read();
    const binding = settings.credentialBinding;
    const generation = this.credentialGeneration;
    const appPassword = binding ? this.credentials.getAppPassword(binding.secretId) : null;

    if (!appPassword || !binding) {
      throw new NyraError(
        "missing-credentials",
        "No stored Nextcloud credentials are available. Log in with the browser first."
      );
    }

    const configuredServer = normalizeServerUrl(settings.serverUrl);
    const boundServer = normalizeServerUrl(binding.serverUrl);
    if (configuredServer !== boundServer) {
      throw new NyraError(
        "credential-server-mismatch",
        "Stored credentials are bound to a different Nextcloud server. Log in with the browser for the configured server before verification."
      );
    }

    const credentials: NextcloudCredentials = {
      serverUrl: boundServer,
      loginName: binding.loginName,
      appPassword
    };

    try {
      const report = await this.verifier.verify(credentials);
      this.assertVerificationScope(generation, boundServer, binding.secretId, binding.loginName);
      await this.settingsPort.update((mutable) => {
        this.assertVerificationSettings(mutable, boundServer, binding.secretId, binding.loginName);
        mutable.serverUrl = report.account.serverUrl;
        mutable.pendingLoginName = null;
        mutable.credentialBinding = {
          serverUrl: report.account.serverUrl,
          loginName: report.account.loginName,
          secretId: binding.secretId
        };
        mutable.account = report.account;
        mutable.connectionState = "verified";
        mutable.lastError = null;
      });
      return report;
    } catch (error) {
      const message = errorMessage(error);
      try {
        this.assertVerificationScope(generation, boundServer, binding.secretId, binding.loginName);
        await this.settingsPort.update((mutable) => {
          this.assertVerificationSettings(mutable, boundServer, binding.secretId, binding.loginName);
          mutable.connectionState = "error";
          mutable.lastError = message;
        });
      } catch { /* A newer account/server state owns settings now; a stale response must not overwrite it. */ }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.credentialGeneration += 1;
    this.preparedLogin = null;
    this.cancelLogin();
    const activeLogin = this.activeLoginPromise;
    if (activeLogin) await activeLogin.catch(() => undefined);
    const binding = this.settingsPort.read().credentialBinding;

    // Remove the durable reference first. If persistence fails, the still-bound
    // credential remains usable instead of leaving data.json pointing at a
    // secret that has already been destroyed. A failed secret cleanup after a
    // successful settings write can only leave an unreachable orphaned slot.
    await this.settingsPort.update((settings) => {
      settings.connectionState = "disconnected";
      settings.account = null;
      settings.pendingLoginName = null;
      settings.credentialBinding = null;
      settings.lastError = null;
    });

    if (binding) {
      try {
        this.credentials.clear(binding.secretId);
      } catch (error) {
        this.logger.warn("auth.disconnected-secret-cleanup-failed", { error: errorMessage(error) });
      }
    }
    this.logger.info("auth.disconnected");
  }

  private assertOpen(): void {
    if (this.closed) throw new NyraError("login-cancelled", "Nextcloud authentication stopped because the plugin is unloading.");
  }

  private getPreparedSession(serverUrl: string): { serverUrl: string; session: LoginFlowSession } | null {
    const prepared = this.preparedLogin;
    if (this.closed || this.activeCancellation || !prepared || !sameServer(prepared.serverUrl, serverUrl)
      || !sameServer(this.settingsPort.read().serverUrl, serverUrl)) return null;
    if (prepared.session.expiresAt <= Date.now() + 10_000) {
      this.preparedLogin = null;
      return null;
    }
    return prepared;
  }

  private assertVerificationScope(generation: number, serverUrl: string, secretId: string, loginName: string): void {
    if (generation !== this.credentialGeneration) {
      throw new NyraError("credential-server-mismatch", "The account changed while its credentials were being verified. Start verification again.");
    }
    this.assertVerificationSettings(this.settingsPort.read(), serverUrl, secretId, loginName);
  }

  private assertVerificationSettings(settings: PluginSettings, serverUrl: string, secretId: string, loginName: string): void {
    const binding = settings.credentialBinding;
    if (!sameServer(settings.serverUrl, serverUrl) || !binding || binding.secretId !== secretId || binding.loginName !== loginName || !sameServer(binding.serverUrl, serverUrl)) {
      throw new NyraError("credential-server-mismatch", "The configured server or account changed during verification. Start verification again.");
    }
  }
}

function sameServer(left: string, right: string): boolean {
  try { return normalizeServerUrl(left) === normalizeServerUrl(right); }
  catch { return false; }
}
