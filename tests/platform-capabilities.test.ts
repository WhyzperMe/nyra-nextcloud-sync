import { describe, expect, it } from "vitest";
import { platformCapabilities } from "../src/platform/capabilities";

describe("platform capability limits", () => {
  it("bounds mobile whole-buffer work and never promises background execution", () => {
    const capabilities = platformCapabilities(true);
    expect(capabilities).toMatchObject({
      isMobile: true,
      maxSafeWholeReadBytes: 32 * 1024 * 1024,
      maxInFlightWholeReadBytes: 32 * 1024 * 1024,
      localReadConcurrency: 1,
      supportsWholeBufferOnly: true,
      guaranteesBackgroundExecution: false
    });
  });

  it("keeps desktop limits explicit and bounded", () => {
    expect(platformCapabilities(false)).toMatchObject({
      isMobile: false,
      maxSafeWholeReadBytes: 128 * 1024 * 1024,
      maxInFlightWholeReadBytes: 64 * 1024 * 1024,
      localReadConcurrency: 4,
      supportsWholeBufferOnly: true,
      guaranteesBackgroundExecution: false
    });
  });
});
