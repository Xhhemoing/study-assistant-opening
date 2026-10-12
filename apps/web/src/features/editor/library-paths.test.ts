import { describe, expect, it } from "vitest";
import { libraryNewNotePath, libraryNotePath } from "./library-paths";

describe("library note paths", () => {
  it("keeps notes inside the Opening shell when given the Opening base", () => {
    expect(libraryNotePath("/opening/library", "doc-1")).toBe("/opening/library/doc-1");
    expect(libraryNewNotePath("/opening/library")).toBe("/opening/library/new");
  });

  it("preserves legacy workspace paths and encodes ids", () => {
    expect(libraryNotePath("/library", "a/b c")).toBe("/library/a%2Fb%20c");
    expect(libraryNewNotePath("/library")).toBe("/library/new");
  });
});
