import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("opening-learning-help persist surface (V2-13 T12)", () => {
  it("insert SQL includes kind, activity_id, item_version_id", () => {
    const src = readFileSync(resolve(__dirname, "opening-learning-help.ts"), "utf8");
    expect(src).toMatch(/kind,activity_id,item_version_id/);
    expect(src).toMatch(/input\.kind/);
    expect(src).toMatch(/help exposure requires kind/);
  });
});
