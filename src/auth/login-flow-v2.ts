import { NyraError } from "../core/errors";
import type { NextcloudCredentials } from "../core/types";
import type { Logger } from "../diagnostics/logger";
import type { HttpTransport } from "../network/http-client";
import { nextcloudEndpoints } from "../nextcloud/endpoints";
import { assertSameOrigin, normalizeServerUrl } from "../security/url-policy";

const TOKEN_LIFETIME_MS = 20 * 60 * 1000;
const CLIENT_DEADLINE_MARGIN_MS = 5_000;
const MAX_POLL_DELAY_MS = 5_000;
const TRANSIENT_POLL_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface LoginFlowOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface LoginInitPayload {
  poll?: {
    token?: string;
    endpoint?: string;
  };
  login?: string;
}

interface LoginPollPayload {
  server?: string;
  loginName?: string;
  appPassword?: string;
}

export interface LoginFlowSession {
  trustedServerUrl: string;
  loginUrl: string;
  pollEndpoint: string;
  pollToken: string;
  expiresAt: number;
}

export interface LoginCancellation {
  readonly cancelled: boolean;
}

export class LoginFlowV2 {
  private readonly clientUserAgent: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly http: HttpTransport,
    private readonly logger: Logger,
    clientVersion: string,
    options: LoginFlowOptions = {}
  ) {
    this.clientUserAgent = `NyraNextcloudSync/${clientVersion} (Obsidian)`;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async begin(serverInput: string): Promise<LoginFlowSession> {
    const trustedServerUrl = normalizeServerUrl(serverInput);
    const response = await this.http.request({
      url: nextcloudEndpoints.loginV2(trustedServerUrl),
      method: "POST",
      headers: {
        Accept: "application/json",
        "User-Agent": this.clientUserAgent
      }
    });

    if (response.status !== 200) {
      const detail = response.status === 401
        ? " Check that the URL is the Nextcloud server base URL (not a WebDAV folder link) and that Login Flow v2 is enabled on the server."
        : "";
      throw new NyraError(
        "login-init-failed",
        `Nextcloud Login Flow v2 could not start (HTTP ${response.status}).${detail}`
      );
    }

    const decoded = response.json();
    if (!isRecord(decoded)) throw new NyraError("invalid-login-response", "Nextcloud returned an invalid Login Flow v2 response.");
    const payload = decoded as LoginInitPayload;
    const token = payload.poll?.token;
    const endpoint = payload.poll?.endpoint;
    const login = payload.login;

    if (!isNonEmptyString(token) || !isNonEmptyString(endpoint) || !isNonEmptyString(login)) {
      throw new NyraError(
        "invalid-login-response",
        "Nextcloud returned an incomplete Login Flow v2 response."
      );
    }

    const loginUrl = assertSameOrigin(trustedServerUrl, login, "cross-origin-login-url");
    const pollEndpoint = assertSameOrigin(trustedServerUrl, endpoint, "cross-origin-poll-url");

    this.logger.info("auth.login-flow-started", {
      serverUrl: trustedServerUrl,
      flow: "nextcloud-login-v2"
    });

    return {
      trustedServerUrl,
      loginUrl,
      pollEndpoint,
      pollToken: token,
      expiresAt: this.now() + TOKEN_LIFETIME_MS - CLIENT_DEADLINE_MARGIN_MS
    };
  }

  async poll(session: LoginFlowSession, cancellation: LoginCancellation): Promise<NextcloudCredentials> {
    let delayMs = 1_000;

    while (this.now() < session.expiresAt) {
      if (cancellation.cancelled) {
        throw new NyraError("login-cancelled", "Browser login was cancelled.");
      }

      let response;
      try {
        response = await this.http.request({
          url: session.pollEndpoint,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          headers: {
            Accept: "application/json"
          },
          body: `token=${encodeURIComponent(session.pollToken)}`
        });
      } catch (error) {
        if (cancellation.cancelled) throw new NyraError("login-cancelled", "Browser login was cancelled.");
        if (error instanceof NyraError && error.code === "network-error") {
          await this.sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 5_000);
          continue;
        }
        throw error;
      }

      if (cancellation.cancelled) throw new NyraError("login-cancelled", "Browser login was cancelled.");

      if (response.status === 404) {
        await this.sleep(delayMs);
        delayMs = 1_000;
        continue;
      }

      if (TRANSIENT_POLL_STATUSES.has(response.status)) {
        delayMs = retryAfterMs(response.headers, this.now()) ?? Math.min(delayMs * 2, MAX_POLL_DELAY_MS);
        await this.sleep(delayMs);
        continue;
      }

      if (response.status !== 200) {
        throw new NyraError(
          "login-poll-failed",
          `Nextcloud login polling failed (HTTP ${response.status}).`
        );
      }

      const decoded = response.json();
      if (!isRecord(decoded)) throw new NyraError("invalid-login-response", "Nextcloud returned an invalid credential response after browser approval.");
      const payload = decoded as LoginPollPayload;
      if (!isNonEmptyString(payload.server) || !isNonEmptyString(payload.loginName) || !isNonEmptyString(payload.appPassword)) {
        throw new NyraError(
          "invalid-login-response",
          "Nextcloud returned incomplete credentials after browser approval."
        );
      }

      const canonicalServer = normalizeServerUrl(payload.server);
      assertSameOrigin(
        session.trustedServerUrl,
        canonicalServer,
        "cross-origin-credential-server"
      );

      this.logger.info("auth.login-flow-completed", {
        serverUrl: canonicalServer,
        loginName: payload.loginName
      });

      return {
        serverUrl: canonicalServer,
        loginName: payload.loginName,
        appPassword: payload.appPassword
      };
    }

    throw new NyraError(
      "login-timeout",
      "Nextcloud browser login timed out. Start the login flow again."
    );
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterMs(headers: Record<string, string>, nowMs: number): number | null {
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1]?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(250, Math.min(MAX_POLL_DELAY_MS, seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(250, Math.min(MAX_POLL_DELAY_MS, date - nowMs));
  return null;
}
