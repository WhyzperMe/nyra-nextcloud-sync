export type NyraErrorCode =
  | "invalid-server-url"
  | "insecure-server-url"
  | "cross-origin-login-url"
  | "cross-origin-poll-url"
  | "cross-origin-credential-server"
  | "login-init-failed"
  | "login-session-not-ready"
  | "login-cancelled"
  | "login-timeout"
  | "login-poll-failed"
  | "invalid-login-response"
  | "network-error"
  | "not-nextcloud"
  | "maintenance-mode"
  | "authentication-rejected"
  | "ocs-verification-failed"
  | "webdav-verification-failed"
  | "webdav-not-found"
  | "webdav-inventory-failed"
  | "webdav-invalid-response"
  | "webdav-response-too-large"
  | "remote-precondition-unreliable"
  | "sync-precondition-changed"
  | "missing-credentials"
  | "credential-server-mismatch";

export class NyraError extends Error {
  readonly code: NyraErrorCode;
  readonly causeValue?: unknown;

  constructor(code: NyraErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.name = "NyraError";
    this.code = code;
    if (causeValue !== undefined) {
      this.causeValue = causeValue;
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
