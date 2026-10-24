import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The seeded soak and state-machine tests are CPU-bound; give slow CI machines headroom.
    testTimeout: 60_000
  }
});
