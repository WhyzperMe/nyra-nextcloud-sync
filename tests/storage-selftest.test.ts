import { describe, expect, it } from "vitest";
import { runStorageSelfTest } from "../src/platform/storage-selftest";
import { MemoryVaultAdapter } from "./helpers/memory-vault";

describe("Storage self-test", () => {
  it("passes on a healthy adapter and leaves nothing behind", async () => {
    const adapter = new MemoryVaultAdapter();
    const checks = await runStorageSelfTest(adapter, "selftest");
    expect(checks.filter((check) => !check.ok), JSON.stringify(checks.filter((check) => !check.ok))).toEqual([]);
    expect(await adapter.exists("selftest")).toBe(false);
  }, 20_000);

  it("reports the exact failure of an adapter that reads short", async () => {
    class ShortRead extends MemoryVaultAdapter {
      override async readBinary(path: string): Promise<ArrayBuffer> {
        const bytes = await super.readBinary(path);
        return path.endsWith("b4096.bin") ? bytes.slice(0, bytes.byteLength - 1) : bytes;
      }
    }
    const checks = await runStorageSelfTest(new ShortRead(), "selftest");
    const failed = checks.filter((check) => !check.ok);
    expect(failed.map((check) => check.name)).toEqual(["Binary round trip 4096 B"]);
    expect(failed[0]?.detail).toMatch(/4095 bytes, expected 4096/);
  }, 20_000);
});
