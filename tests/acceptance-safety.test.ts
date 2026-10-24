import { describe, expect, it } from "vitest";
import { uniqueAcceptancePath, validateAcceptanceConfig } from "../e2e/acceptance-safety";

const SAFE_ENV = {
  NYRA_ACCEPTANCE_ENABLE: "1",
  NYRA_ACCEPTANCE_ALLOW_DESTRUCTIVE_TEST_ROOT: "YES",
  NYRA_ACCEPTANCE_SERVER: "https://cloud.example/nc",
  NYRA_ACCEPTANCE_USER: "acceptance-user",
  NYRA_ACCEPTANCE_APP_PASSWORD: "test-only-secret",
  NYRA_ACCEPTANCE_ROOT: "NyraAcceptanceTests"
} as const;

describe("opt-in live acceptance guard", () => {
  it("accepts only explicitly acknowledged, dedicated relative test roots", () => {
    const config = validateAcceptanceConfig(SAFE_ENV);
    expect(config.serverUrl).toBe("https://cloud.example/nc");
    expect(config.remoteRoot).toBe("NyraAcceptanceTests");
    expect(uniqueAcceptancePath(config.remoteRoot, "nyra-acceptance-12345678")).toBe("NyraAcceptanceTests/nyra-acceptance-12345678");
  });

  it("is disabled without the explicit enable and destructive acknowledgements", () => {
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_ENABLE: undefined })).toThrow(/disabled/i);
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_ALLOW_DESTRUCTIVE_TEST_ROOT: undefined })).toThrow(/ALLOW_DESTRUCTIVE/i);
  });

  it("refuses roots that can target the production folder or a broad remote root", () => {
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_ROOT: "/" })).toThrow(/relative/i);
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_ROOT: "NyraAcceptanceTests/../Notes" })).toThrow(/Invalid path segment/i);
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_ROOT: "Notes" })).toThrow(/dedicated/i);
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_PRODUCTION_ROOT: "NyraAcceptanceTests/Prod" })).toThrow(/overlaps/i);
  });

  it("rejects insecure or credential-bearing server URLs before network access", () => {
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_SERVER: "http://cloud.example" })).toThrow(/HTTPS/i);
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_SERVER: "https://user:pass@cloud.example" })).toThrow(/credentials/i);
    expect(() => validateAcceptanceConfig({ ...SAFE_ENV, NYRA_ACCEPTANCE_SERVER: "https://cloud.example/?token=secret" })).toThrow(/query/i);
  });
});
