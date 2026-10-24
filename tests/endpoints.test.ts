import { describe, expect, it } from "vitest";
import { nextcloudEndpoints } from "../src/nextcloud/endpoints";

describe("Nextcloud endpoints", () => {
  it("builds Login Flow v2 under a subpath installation", () => {
    expect(nextcloudEndpoints.loginV2("https://cloud.example.com/nc")).toBe(
      "https://cloud.example.com/nc/index.php/login/v2"
    );
  });

  it("percent-encodes a DAV user id", () => {
    expect(nextcloudEndpoints.webdavUserRoot("https://cloud.example.com", "user name")).toBe(
      "https://cloud.example.com/remote.php/dav/files/user%20name/"
    );
  });
});
