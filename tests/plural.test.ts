import { describe, expect, it } from "vitest";
import { isAre, needs, plural } from "../src/core/plural";

describe("plural helpers", () => {
  it("never produces '(s)' and handles one, zero and large counts", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "clean record")).toBe("2 clean records");
    expect(plural(12847, "deletion")).toBe(`${new Intl.NumberFormat().format(12847)} deletions`);
    expect(`${plural(1, "item")} ${needs(1)} review`).toBe("1 item needs review");
    expect(`${plural(3, "item")} ${needs(3)} review`).toBe("3 items need review");
    expect(`${plural(1, "deletion")} ${isAre(1)} waiting`).toBe("1 deletion is waiting");
    expect(`${plural(28, "deletion")} ${isAre(28)} waiting`).toBe("28 deletions are waiting");
  });
});
