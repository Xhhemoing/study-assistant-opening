import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS } from "@aistudy/contracts";
import { createOpeningAiSettingsRepository, createWorkspacePreferencesRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id IN (${fixture.scope.workspaceId},${fixture.otherScope.workspaceId})`;
});
afterAll(async () => { await fixture?.close(); });
describe("workspace AI settings repository", () => {
  it("defaults to server routing without changing existing preferences", async () => {
    const original = createWorkspacePreferencesRepository(fixture.sql);
    await original.setDefaultEntry(fixture.scope.workspaceId, "library");
    await original.setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: false });
    const repo = createOpeningAiSettingsRepository(fixture.sql);
    expect(await repo.get(fixture.scope)).toEqual({ settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false });
    await repo.set(fixture.scope, { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual", manualModelId: "chosen" });
    expect((await repo.get(fixture.scope)).settings.manualModelId).toBe("chosen");
    expect(await original.getDefaultEntry(fixture.scope.workspaceId)).toBe("library");
    expect((await original.getLearningPreferences(fixture.scope)).assessmentEnabled).toBe(true);
    await repo.set(fixture.scope, null);
    expect((await repo.get(fixture.scope)).saved).toBe(false);
    expect(await original.getDefaultEntry(fixture.scope.workspaceId)).toBe("library");
  });
  it("isolates workspaces and checks the owner on reads and writes", async () => {
    const repo = createOpeningAiSettingsRepository(fixture.sql);
    await repo.set(fixture.scope, { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "first" });
    expect((await repo.get(fixture.otherScope)).settings.defaultModelId).toBeNull();
    const foreign = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
    await expect(repo.get(foreign)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.set(foreign, null)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await repo.get(fixture.scope)).settings.defaultModelId).toBe("first");
  });
  it("surfaces corrupt stored preferences for explicit recovery", async () => {
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id,ai_settings) VALUES (${fixture.scope.workspaceId},'{"mode":"unknown"}'::jsonb)`;
    const repo = createOpeningAiSettingsRepository(fixture.sql);
    expect(await repo.get(fixture.scope)).toMatchObject({ saved: true, invalidStoredSettings: true });
    await repo.set(fixture.scope, null);
    expect((await repo.get(fixture.scope)).invalidStoredSettings).toBe(false);
  });
  it("rejects a credential-shaped document before persistence", async () => {
    const repo = createOpeningAiSettingsRepository(fixture.sql);
    await expect(repo.set(fixture.scope, { ...DEFAULT_OPENING_AI_SETTINGS, apiKey: "not-allowed" } as never)).rejects.toThrow();
    expect((await repo.get(fixture.scope)).saved).toBe(false);
  });
});
