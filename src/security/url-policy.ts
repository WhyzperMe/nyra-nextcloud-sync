import { NyraError } from "../core/errors";
import { normalizeRemoteRootPath } from "../remote/path";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new NyraError("invalid-server-url", "Enter a Nextcloud server URL.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new NyraError("invalid-server-url", "The Nextcloud server URL is not valid.", error);
  }

  if (url.username || url.password) {
    throw new NyraError(
      "invalid-server-url",
      "Do not include credentials in the server URL. Use browser login instead."
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NyraError("invalid-server-url", "The server URL must use HTTPS.");
  }

  if (url.protocol === "http:" && !isLoopback(url)) {
    throw new NyraError(
      "insecure-server-url",
      "HTTPS is required for remote Nextcloud servers. Plain HTTP is allowed only on loopback for local development."
    );
  }

  url.hash = "";
  url.search = "";
  url.pathname = normalizeBasePath(stripKnownNextcloudEndpoint(url.pathname));
  return url.toString().replace(/\/$/, "");
}

/** Preserve the folder selected in a pasted Nextcloud Files or WebDAV link. */
export function parseNextcloudLocation(input: string): { serverUrl: string; remoteRootPath: string | null } {
  const serverUrl = normalizeServerUrl(input);
  const url = new URL(input.trim());
  const filesPage = /\/index\.php\/apps\/files\/files(?:\/[^/]*)?\/?$/i.test(url.pathname);
  if (filesPage) {
    const directories = url.searchParams.getAll("dir");
    if (directories.length > 1) throw new NyraError("invalid-server-url", "The Nextcloud Files link contains multiple folder selections.");
    return { serverUrl, remoteRootPath: directories[0]?.trim() ? normalizeRemoteRootPath(directories[0]) : null };
  }
  const dav = /\/remote\.php\/dav\/files\/[^/]+(?:\/(.*))?$/i.exec(url.pathname);
  if (!dav) return { serverUrl, remoteRootPath: null };
  const segments = dav[1] ? dav[1].replace(/\/$/, "").split("/") : [];
  const decoded = segments.map((segment) => {
    let value: string;
    try { value = decodeURIComponent(segment); }
    catch { throw new NyraError("invalid-server-url", "The WebDAV folder link has invalid encoding."); }
    if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
      throw new NyraError("invalid-server-url", "The WebDAV folder link contains an unsafe path segment.");
    }
    return value;
  });
  return { serverUrl, remoteRootPath: decoded.length ? normalizeRemoteRootPath(decoded.join("/")) : null };
}

export function appendServerPath(serverUrl: string, path: string): string {
  const base = new URL(normalizeServerUrl(serverUrl));
  const cleanPath = path.replace(/^\/+/, "");
  const basePath = base.pathname.replace(/\/$/, "");
  base.pathname = `${basePath}/${cleanPath}`.replace(/\/{2,}/g, "/");
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function assertSameOrigin(
  trustedServerUrl: string,
  candidateUrl: string,
  code: "cross-origin-login-url" | "cross-origin-poll-url" | "cross-origin-credential-server"
): string {
  const trusted = new URL(normalizeServerUrl(trustedServerUrl));
  let candidate: URL;
  try {
    candidate = new URL(candidateUrl);
  } catch (error) {
    throw new NyraError(code, "Nextcloud returned an invalid URL.", error);
  }

  if (candidate.username || candidate.password) {
    throw new NyraError(code, "Nextcloud returned a URL containing embedded credentials. Refusing to continue.");
  }

  if (candidate.origin !== trusted.origin) {
    throw new NyraError(
      code,
      `Nextcloud returned a URL on a different origin (${candidate.origin}). Refusing to continue.`
    );
  }

  if (candidate.protocol !== "https:" && !(candidate.protocol === "http:" && isLoopback(candidate))) {
    throw new NyraError(code, "Nextcloud returned an insecure URL. Refusing to continue.");
  }

  return candidate.toString();
}

export function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) || url.hostname === "::1";
}

function normalizeBasePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed === "/") {
    return "/";
  }
  return collapsed.replace(/\/$/, "");
}

/** Accept pasted Files/WebDAV links without treating their endpoint path as the server base. */
function stripKnownNextcloudEndpoint(pathname: string): string {
  const endpointStart = pathname.search(/\/(?:remote\.php\/(?:dav|webdav)|index\.php(?:\/(?:apps\/files|login\/v2))?|ocs\/v2\.php|status\.php)(?:\/|$)/i);
  return endpointStart < 0 ? pathname : pathname.slice(0, endpointStart) || "/";
}
