import { describe, expect, it } from "vitest";
import { OpeningApiError } from "../client/api";
import { formatTurnError, pageForSubmit } from "./turn-errors";

describe("turn-errors (T03 联调)", () => {
  it("explains page_not_in_sources 422", () => {
    expect(
      formatTurnError(new OpeningApiError(422, "page_not_in_sources", "page_not_in_sources")),
    ).toContain("清空页码");
  });

  it("omits empty page for submit", () => {
    expect(pageForSubmit("")).toBeUndefined();
    expect(pageForSubmit("2")).toBe(2);
  });
});
