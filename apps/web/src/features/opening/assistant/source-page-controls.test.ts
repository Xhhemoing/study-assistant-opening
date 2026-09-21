import { describe, expect, it } from "vitest";
import { isSourceSelectable } from "./source-page-controls";

describe("source page controls", () => {
  it("only selects uploaded sources whose parsing is ready", () => {
    const source = (uploadState: "uploaded" | "pending", parseState: "ready" | "running") => ({
      uploadState,
      parseState,
    });

    expect(isSourceSelectable(source("uploaded", "ready"))).toBe(true);
    expect(isSourceSelectable(source("uploaded", "running"))).toBe(false);
    expect(isSourceSelectable(source("pending", "ready"))).toBe(false);
  });
});
