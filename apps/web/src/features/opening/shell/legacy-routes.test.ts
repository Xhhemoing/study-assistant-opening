import { describe, expect, it } from "vitest";
import { openingAliasHref } from "./legacy-routes";

describe("retained route aliases", () => {
  it("preserves duplicate filters and pinned source positions", () => {
    const href = openingAliasHref("/opening/library", { source: "source-a", version: "0", page: "3", tag: ["linear", "复习"], empty: "" });
    const url = new URL(href, "https://study.invalid");
    expect(url.pathname).toBe("/opening/library");
    expect(url.searchParams.getAll("tag")).toEqual(["linear", "复习"]);
    expect(url.searchParams.get("version")).toBe("0");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("empty")).toBe("");
  });
  it("encodes return addresses as data and keeps an empty alias simple", () => {
    const target = "/opening/courses/course-a?tab=progress&task=task-a";
    expect(new URL(openingAliasHref("/opening/settings", { returnTo: target }), "https://study.invalid").searchParams.get("returnTo")).toBe(target);
    expect(openingAliasHref("/opening/settings", {})).toBe("/opening/settings");
  });
});
