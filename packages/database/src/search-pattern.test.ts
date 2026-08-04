import { describe, expect, it } from "vitest";
import { escapeLikePattern, wrapLikePattern } from "./search-pattern";

describe("ILIKE pattern escaping", () => {
  it("keeps plain text unchanged", () => {
    expect(escapeLikePattern("线性代数")).toBe("线性代数");
    expect(wrapLikePattern("导数")).toBe("%导数%");
  });

  it("escapes wildcards with a single backslash so they match literally", () => {
    // PostgreSQL ILIKE: \% matches literal %, \\ matches literal \.
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(wrapLikePattern("100%")).toBe("%100\\%%");
  });

  it("escapes a literal backslash in the query", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("escapes every wildcard occurrence", () => {
    expect(escapeLikePattern("%%")).toBe("\\%\\%");
    expect(escapeLikePattern("_%")).toBe("\\_\\%");
  });
});
