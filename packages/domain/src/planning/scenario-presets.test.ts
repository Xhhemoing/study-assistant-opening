import { describe, it, expect } from "vitest";
import { getScenarioPresetDefinition } from "./scenario-presets";
import type { ScenarioPreset } from "@aistudy/contracts";

describe("scenario-presets registry", () => {
  it("returns definition for 'final'", () => {
    const def = getScenarioPresetDefinition("final" as ScenarioPreset);
    expect(def.id).toBe("final");
    expect(def.tierOrder).toEqual(["weak", "untested", "usable"]);
  });

  it("throws on unknown preset", () => {
    expect(() => getScenarioPresetDefinition("unknown" as ScenarioPreset)).toThrow(/unknown scenario preset/i);
  });
});
