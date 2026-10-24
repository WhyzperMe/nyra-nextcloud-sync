import { NyraError } from "../core/errors";
import type {
  NextcloudCredentials,
  NextcloudStatus,
  VerificationReport,
  VerifiedAccount
} from "../core/types";
import type { Logger } from "../diagnostics/logger";
import type { HttpTransport } from "../network/http-client";
import { basicAuthorization } from "../security/base64";
import { assertSameOrigin, normalizeServerUrl } from "../security/url-policy";
import { nextcloudEndpoints } from "./endpoints";
import { isRecord, unwrapOcsData } from "./ocs";

export class ConnectionVerifier {
  constructor(
    private readonly http: HttpTransport,
    private readonly logger: Logger
  ) {}

  async verify(credentials: NextcloudCredentials): Promise<VerificationReport> {
    const serverUrl = normalizeServerUrl(credentials.serverUrl);
    const authHeader = basicAuthorization(credentials.loginName, credentials.appPassword);

    const status = await this.verifyStatus(serverUrl);
    const userData = await this.verifyIdentity(serverUrl, authHeader);
    const userId = requiredString(userData, "id", "OCS user identity");
    const displayName = optionalString(userData, "displayname") ?? userId;
    const capabilities = await this.verifyCapabilities(serverUrl, authHeader);
    const webdavRootUrl = nextcloudEndpoints.webdavUserRoot(serverUrl, userId);
    assertSameOrigin(serverUrl, webdavRootUrl, "cross-origin-credential-server");
    await this.verifyWebdav(webdavRootUrl, authHeader);

    const account: VerifiedAccount = {
      serverUrl,
      loginName: credentials.loginName,
      userId,
      displayName,
      webdavRootUrl,
      serverVersion: status.version,
      serverVersionString: status.versionString,
      verifiedAt: new Date().toISOString()
    };

    this.logger.info("connection.verified", {
      serverUrl,
      loginName: credentials.loginName,
      userId,
      serverVersion: status.versionString
    });

    return { account, capabilities, status };
  }

  private async verifyStatus(serverUrl: string): Promise<NextcloudStatus> {
    const response = await this.http.request({
      url: nextcloudEndpoints.status(serverUrl),
      method: "GET",
      headers: { Accept: "application/json" }
    });

    if (response.status !== 200) {
      throw new NyraError(
        "not-nextcloud",
        `The server did not return a valid Nextcloud status response (HTTP ${response.status}).`
      );
    }
    const rawPayload = response.json();
    if (!isRecord(rawPayload)) {
      throw new NyraError("not-nextcloud", "The server returned an invalid Nextcloud status payload.");
    }

    const payload = rawPayload;
    const productName = optionalString(payload, "productname") ?? "";
    const installed = payload.installed === true;
    const maintenance = payload.maintenance === true;
    const needsDbUpgrade = payload.needsDbUpgrade === true;

    if (!installed || !productName.toLowerCase().includes("nextcloud")) {
      throw new NyraError("not-nextcloud", "The configured server does not identify itself as Nextcloud.");
    }
    if (maintenance || needsDbUpgrade) {
      throw new NyraError(
        "maintenance-mode",
        "Nextcloud is in maintenance mode or requires a database upgrade. Try again after server maintenance is complete."
      );
    }

    return {
      installed,
      maintenance,
      needsDbUpgrade,
      version: optionalString(payload, "version") ?? "unknown",
      versionString: optionalString(payload, "versionstring") ?? "unknown",
      productName
    };
  }

  private async verifyIdentity(serverUrl: string, authorization: string): Promise<Record<string, unknown>> {
    const response = await this.http.request({
      url: nextcloudEndpoints.currentUser(serverUrl),
      method: "GET",
      headers: ocsHeaders(authorization)
    });

    if (response.status === 401 || response.status === 403) {
      throw new NyraError(
        "authentication-rejected",
        "Nextcloud rejected the generated app password. Reconnect the account."
      );
    }
    if (response.status !== 200) {
      throw new NyraError(
        "ocs-verification-failed",
        `The Nextcloud user endpoint failed (HTTP ${response.status}).`
      );
    }

    const data = unwrapOcsData(response.json(), "Nextcloud user endpoint");
    if (!isRecord(data)) {
      throw new NyraError("ocs-verification-failed", "Nextcloud returned an invalid user identity payload.");
    }
    return data;
  }

  private async verifyCapabilities(serverUrl: string, authorization: string): Promise<unknown> {
    const response = await this.http.request({
      url: nextcloudEndpoints.capabilities(serverUrl),
      method: "GET",
      headers: ocsHeaders(authorization)
    });

    if (response.status === 401 || response.status === 403) {
      throw new NyraError("authentication-rejected", "Nextcloud rejected credentials while reading capabilities.");
    }
    if (response.status !== 200) {
      throw new NyraError(
        "ocs-verification-failed",
        `The Nextcloud capabilities endpoint failed (HTTP ${response.status}).`
      );
    }
    return unwrapOcsData(response.json(), "Nextcloud capabilities endpoint");
  }

  private async verifyWebdav(webdavRootUrl: string, authorization: string): Promise<void> {
    const response = await this.http.request({
      url: webdavRootUrl,
      method: "PROPFIND",
      contentType: "application/xml; charset=utf-8",
      headers: {
        Authorization: authorization,
        Depth: "0",
        Accept: "application/xml"
      },
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:resourcetype/><d:getetag/><oc:fileid/><oc:checksums/></d:prop></d:propfind>`
    });

    if (response.status === 401 || response.status === 403) {
      throw new NyraError("authentication-rejected", "Nextcloud rejected credentials for WebDAV.");
    }
    if (response.status !== 207) {
      throw new NyraError(
        "webdav-verification-failed",
        `WebDAV verification failed (HTTP ${response.status}).`
      );
    }
  }
}

function ocsHeaders(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    "OCS-APIRequest": "true",
    Accept: "application/json"
  };
}

function requiredString(source: Record<string, unknown>, key: string, context: string): string {
  const value = optionalString(source, key);
  if (!value) {
    throw new NyraError("ocs-verification-failed", `${context} is missing '${key}'.`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : null;
}
