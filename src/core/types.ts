export type ConnectionState =
  | "disconnected"
  | "authenticating"
  | "pending-verification"
  | "verified"
  | "error";

export interface NextcloudCredentials {
  serverUrl: string;
  loginName: string;
  appPassword: string;
}

export interface VerifiedAccount {
  serverUrl: string;
  loginName: string;
  userId: string;
  displayName: string;
  webdavRootUrl: string;
  serverVersion: string;
  serverVersionString: string;
  verifiedAt: string;
}

export interface VerificationReport {
  account: VerifiedAccount;
  capabilities: unknown;
  status: NextcloudStatus;
}

export interface NextcloudStatus {
  installed: boolean;
  maintenance: boolean;
  needsDbUpgrade: boolean;
  version: string;
  versionString: string;
  productName: string;
}
