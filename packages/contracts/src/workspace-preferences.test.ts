import { describe, expect, it } from "vitest";
import {
  workspaceDefaultEntrySchema,
  workspacePreferenceResponseSchema,
  workspacePreferenceUpdateSchema,
} from "./workspace-preferences";

describe("workspace preference contracts", () => {
  it("accepts the three workspace entries and rejects unknown entries", () => {
    for (const entry of ["learn", "explore", "library"] as const) {
      expect(workspaceDefaultEntrySchema.parse(entry)).toBe(entry);
    }

    expect(() => workspaceDefaultEntrySchema.parse("invalid")).toThrow();
  });

  it("strips a client workspace id from a default-entry update", () => {
    expect(workspacePreferenceUpdateSchema.parse({ defaultEntry: "explore" })).toEqual({
      defaultEntry: "explore",
    });
    expect(workspacePreferenceUpdateSchema.parse({
      defaultEntry: "explore",
      workspaceId: "11111111-1111-4111-8111-111111111111",
    })).toEqual({ defaultEntry: "explore" });
  });

  it("represents an unset workspace preference explicitly", () => {
    expect(workspacePreferenceResponseSchema.parse({ defaultEntry: null })).toEqual({
      defaultEntry: null,
    });
  });
});
