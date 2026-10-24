import { describe, expect, it } from "vitest";
import { runEngineScenarios } from "../e2e/engine-scenarios";
import { FakeNextcloudDav } from "./helpers/fake-nextcloud";

describe("Complete two-device sync cycles", () => {
  it("converges creates, merges, restart, and folder-content deletion without resurrection", async () => {
    const serverUrl = "https://cloud.engine.test";
    const checks = await runEngineScenarios({ serverUrl, userId: "u", appPassword: "test-only", remoteRoot: "Obsidian" }, "Obsidian/EngineTests", new FakeNextcloudDav(serverUrl, "u"));
    expect(checks).toHaveLength(5);
  });
});
