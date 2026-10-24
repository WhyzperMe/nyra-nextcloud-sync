import { describe, expect, it } from "vitest";
import type { Logger } from "../src/diagnostics/logger";
import { LocalPathPolicy } from "../src/local/path-policy";
import { NextcloudDavClient } from "../src/remote/dav-client";
import { RemoteInventoryScanner } from "../src/remote/scanner";
import { NYRA_REMOTE_RUNTIME_ROOT } from "../src/remote/path";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("Internal remote evidence is never synchronized", () => {
  it("always excludes internal runtime paths from local scope even with custom reserved roots", () => {
    for (const policy of [new LocalPathPolicy(), new LocalPathPolicy([]), new LocalPathPolicy({ reservedRoots: [], syncObsidianConfig: () => true })]) {
      expect(policy.isIncluded(`${NYRA_REMOTE_RUNTIME_ROOT}/probe.txt`)).toBe(false);
      expect(policy.isIncluded(`nested/${NYRA_REMOTE_RUNTIME_ROOT}/probe.txt`)).toBe(false);
      expect(policy.isIncluded(`nested/${NYRA_REMOTE_RUNTIME_ROOT}-notes/keep.md`)).toBe(true);
    }
  });

  it("never discovers retained probes under selected/nested roots without an injected path policy", async () => {
    const serverUrl = "https://cloud.example.test";
    const root = `${serverUrl}/remote.php/dav/files/alice/`;
    const dav = new FakeNextcloudDav(serverUrl, "alice");
    for (const directory of [NYRA_REMOTE_RUNTIME_ROOT, `Obsidian/${NYRA_REMOTE_RUNTIME_ROOT}`, "Obsidian/nested", `Obsidian/nested/${NYRA_REMOTE_RUNTIME_ROOT}`]) {
      await dav.request({ url: root + directory, method: "MKCOL" });
      if (directory.endsWith(NYRA_REMOTE_RUNTIME_ROOT)) await dav.request({ url: `${root}${directory}/retained-probe.txt`, method: "PUT", body: "evidence" });
    }
    await dav.request({ url: `${root}Obsidian/keep.md`, method: "PUT", body: "note" });
    const requests: string[] = [];
    const client = new NextcloudDavClient({ request: async (input) => { requests.push(input.url); return await dav.request(input); } },
      { serverUrl, loginName: "alice", appPassword: "fixture" }, logger);
    for (const scope of ["", "Obsidian"]) {
      const scan = await new RemoteInventoryScanner(client, root, logger).scanFull(scope);
      expect(scan.trust).toBe("authoritative");
      expect(scan.entries).toHaveLength(1);
      expect(scan.entries[0]?.path).toBe(scope ? "keep.md" : "Obsidian/keep.md");
    }
    expect(requests.some((url) => url.includes(NYRA_REMOTE_RUNTIME_ROOT))).toBe(false);
  });
});
