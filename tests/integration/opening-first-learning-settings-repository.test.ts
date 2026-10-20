import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts";
import { createOpeningPlanningSettingsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
describe("first-learning schedule initialization", () => {
  it("initializes once, preserves unrelated preferences and serializes concurrent attempts", async () => {
    const repo = createOpeningPlanningSettingsRepository(fixture.sql);
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id,default_entry) VALUES (${fixture.scope.workspaceId},'library')`;
    const original = { ...DEFAULT_OPENING_PLANNING_SETTINGS, dailyWindow: { start: "19:00", end: "19:30" } };
    const other = { ...original, dailyWindow: { start: "20:00", end: "21:00" } };
    const results = await Promise.all([repo.initialize(fixture.scope, original), repo.initialize(fixture.scope, other)]);
    expect(results.sort()).toEqual([false, true]);
    const saved = (await repo.get(fixture.scope)).settings;
    expect([original, other]).toContainEqual(saved);
    expect(await repo.initialize(fixture.scope, original)).toBe(false);
    expect((await repo.get(fixture.scope)).settings).toEqual(saved);
    const [preferences] = await fixture.sql`SELECT default_entry FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(preferences!.default_entry).toBe("library");
  });
  it("does not overwrite invalid but nonempty stored settings", async () => {
    const repo = createOpeningPlanningSettingsRepository(fixture.sql);
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id,planning_settings) VALUES (${fixture.scope.workspaceId},'{"invalid":true}'::jsonb)
      ON CONFLICT(workspace_id) DO UPDATE SET planning_settings=EXCLUDED.planning_settings`;
    expect(await repo.initialize(fixture.scope, DEFAULT_OPENING_PLANNING_SETTINGS)).toBe(false);
    expect((await repo.get(fixture.scope)).invalidStoredSettings).toBe(true);
  });
  it("rejects another owner's scope and an invalid zone", async () => {
    const repo = createOpeningPlanningSettingsRepository(fixture.sql);
    await expect(repo.initialize({ ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }, DEFAULT_OPENING_PLANNING_SETTINGS)).rejects.toThrow();
    await expect(repo.initialize(fixture.otherScope, { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "fake/zone" })).rejects.toThrow();
    expect((await repo.get(fixture.otherScope)).saved).toBe(false);
  });
});
