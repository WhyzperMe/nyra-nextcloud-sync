import { canonicalVaultRelativePath } from "../src/state/durable/path";
import { normalizeServerUrl } from "../src/security/url-policy";

export interface AcceptanceConfig {
  serverUrl: string;
  userId: string;
  appPassword: string;
  remoteRoot: string;
}

/** Fails closed before any network call unless the operator explicitly opts in. */
export function validateAcceptanceConfig(env: Readonly<Record<string, string | undefined>>): AcceptanceConfig {
  if (env.NYRA_ACCEPTANCE_ENABLE !== "1") throw new Error("Live acceptance is disabled. Set NYRA_ACCEPTANCE_ENABLE=1 to opt in.");
  if (env.NYRA_ACCEPTANCE_ALLOW_DESTRUCTIVE_TEST_ROOT !== "YES") {
    throw new Error("Live acceptance requires NYRA_ACCEPTANCE_ALLOW_DESTRUCTIVE_TEST_ROOT=YES.");
  }

  const serverInput = required(env.NYRA_ACCEPTANCE_SERVER, "NYRA_ACCEPTANCE_SERVER");
  const rawServer = new URL(serverInput);
  if (rawServer.username || rawServer.password || rawServer.search || rawServer.hash) {
    throw new Error("Acceptance server URL must not contain credentials, a query string, or a fragment.");
  }
  const serverUrl = normalizeServerUrl(serverInput);
  const userId = required(env.NYRA_ACCEPTANCE_USER, "NYRA_ACCEPTANCE_USER");
  const appPassword = required(env.NYRA_ACCEPTANCE_APP_PASSWORD, "NYRA_ACCEPTANCE_APP_PASSWORD");
  if (/[\u0000-\u001f\u007f]/.test(userId) || /[\u0000-\u001f\u007f]/.test(appPassword)) {
    throw new Error("Acceptance credentials contain invalid control characters.");
  }

  const rootInput = required(env.NYRA_ACCEPTANCE_ROOT, "NYRA_ACCEPTANCE_ROOT");
  if (rootInput.startsWith("/") || rootInput.startsWith("\\") || rootInput.endsWith("/")) {
    throw new Error("Acceptance root must be a dedicated relative folder path, not an absolute or root path.");
  }
  const remoteRoot = canonicalVaultRelativePath(rootInput);
  if (!/(?:acceptance|test)/i.test(remoteRoot)) {
    throw new Error("Acceptance root must clearly identify a dedicated test/acceptance folder.");
  }

  const configuredProductionRoots = [
    env.NYRA_ACCEPTANCE_PRODUCTION_ROOT,
    env.NYRA_PRODUCTION_ROOT,
    env.NYRA_NEXTCLOUD_ROOT,
    env.NYRA_REMOTE_ROOT_PATH
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const configuredRoot of configuredProductionRoots) {
    let productionRoot: string;
    try {
      productionRoot = canonicalVaultRelativePath(configuredRoot.trim().replace(/^\/+|\/+$/g, ""));
    } catch {
      throw new Error("A configured production root is not a safe relative path; refusing live acceptance.");
    }
    if (pathsOverlap(remoteRoot, productionRoot)) {
      throw new Error("Acceptance root overlaps a configured production root; refusing destructive tests.");
    }
  }

  return { serverUrl, userId, appPassword, remoteRoot };
}

export function uniqueAcceptancePath(remoteRoot: string, runId: string): string {
  const root = canonicalVaultRelativePath(remoteRoot);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId)) throw new Error("Acceptance run ID must be a unique safe token.");
  return `${root}/${runId}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Live acceptance requires ${name}.`);
  return trimmed;
}
