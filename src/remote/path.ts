export const NYRA_REMOTE_RUNTIME_ROOT = ".nyra-nextcloud-sync-runtime" as const;

import { canonicalVaultRelativePath } from "../state/durable/path";

export function normalizeRemoteRootPath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  return canonicalVaultRelativePath(trimmed);
}

export function appendWebdavPath(rootUrl: string, relativePath: string): string {
  const root = new URL(ensureTrailingSlash(rootUrl));
  const normalized = normalizeRemoteRootPath(relativePath);
  if (!normalized) return root.toString();
  const encoded = normalized.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  root.pathname = `${ensureTrailingSlash(root.pathname)}${encoded}`;
  return root.toString();
}

export function relativePathFromDavHref(scanRootUrl: string, href: string): string | null {
  // URL normalizes percent-encoded dot segments while parsing (for example
  // `%2e%2e`). Inspect the server-provided path before handing it to URL so
  // traversal cannot be hidden by that normalization.
  decodePathSegments(extractRawHrefPath(href));
  const root = new URL(ensureTrailingSlash(scanRootUrl));
  const target = new URL(href, root.origin);
  if (target.username || target.password || target.search || target.hash) {
    throw new Error("WebDAV href contains credentials, a query string, or a fragment.");
  }
  if (target.origin !== root.origin) throw new Error("WebDAV response contains a cross-origin href.");

  const rootSegments = decodePathSegments(root.pathname);
  const targetSegments = decodePathSegments(target.pathname);
  if (targetSegments.length < rootSegments.length) throw new Error("WebDAV href escapes the configured scan root.");
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (targetSegments[index] !== rootSegments[index]) throw new Error("WebDAV href is outside the configured scan root.");
  }
  const relativeSegments = targetSegments.slice(rootSegments.length);
  if (relativeSegments.length === 0) return null;
  return canonicalVaultRelativePath(relativeSegments.join("/"));
}

function extractRawHrefPath(href: string): string {
  const queryOrFragment = href.search(/[?#]/);
  const withoutQueryOrFragment = queryOrFragment < 0 ? href : href.slice(0, queryOrFragment);
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.exec(withoutQueryOrFragment);
  if (scheme) {
    const authorityStart = scheme[0].length;
    const pathStart = withoutQueryOrFragment.indexOf("/", authorityStart);
    return pathStart < 0 ? "/" : withoutQueryOrFragment.slice(pathStart);
  }
  if (withoutQueryOrFragment.startsWith("//")) {
    const pathStart = withoutQueryOrFragment.indexOf("/", 2);
    return pathStart < 0 ? "/" : withoutQueryOrFragment.slice(pathStart);
  }
  return withoutQueryOrFragment;
}

function decodePathSegments(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return [];
  return trimmed.split("/").map((segment) => {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error("WebDAV href contains invalid percent encoding."); }
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      throw new Error("WebDAV href contains an unsafe path segment.");
    }
    return decoded;
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
