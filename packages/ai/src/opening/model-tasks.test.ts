import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, modelTaskKeySchema, openingAiSettingsResponseSchema } from "@aistudy/contracts";
import { MODEL_TASKS } from "./model-tasks";

describe("registered model task contracts", () => {
  it.each(Object.keys(MODEL_TASKS))("accepts registered key %s", key => {
    expect(modelTaskKeySchema.parse(key)).toBe(key);
  });

  it("accepts the entire registry and persisted routes in a complete settings response", () => {
    const tasks = Object.entries(MODEL_TASKS).map(([key, spec]) => ({ key, label: spec.label, group: spec.group, needs: "needs" in spec ? [...spec.needs] : [] }));
    const taskRoutes = Object.fromEntries(tasks.map(task => [task.key, { primary: null, fallback: null }]));
    const response = { models: [], defaultModelId: null, dailyCapCents: 0, envCapCents: 0, personalCeilingCents: 2000,
      settings: { ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes }, tasks, saved: true, invalidStoredSettings: false };
    expect(openingAiSettingsResponseSchema.parse(response)).toEqual(response);
  });
});
