import { appendServerPath } from "../security/url-policy";

export const nextcloudEndpoints = {
  loginV2(serverUrl: string): string {
    return appendServerPath(serverUrl, "index.php/login/v2");
  },

  status(serverUrl: string): string {
    return appendServerPath(serverUrl, "status.php");
  },

  currentUser(serverUrl: string): string {
    return `${appendServerPath(serverUrl, "ocs/v2.php/cloud/user")}?format=json`;
  },

  capabilities(serverUrl: string): string {
    return `${appendServerPath(serverUrl, "ocs/v2.php/cloud/capabilities")}?format=json`;
  },

  webdavUserRoot(serverUrl: string, userId: string): string {
    return appendServerPath(serverUrl, `remote.php/dav/files/${encodeURIComponent(userId)}/`);
  },

  webdavUploadsRoot(serverUrl: string, userId: string): string {
    return appendServerPath(serverUrl, `remote.php/dav/uploads/${encodeURIComponent(userId)}/`);
  }
};
