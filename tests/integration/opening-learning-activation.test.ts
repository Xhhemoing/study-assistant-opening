import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspacePreferencesRepository, lockLearningPreferences,
  readLearningAutomationState, setCourseLearningPreferences,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const enabled = { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true };

describe("opening learning automation activation", () => {
  let fixture: OpeningFixture;
  let courseId: string;

  beforeEach(async () => {
    fixture = await createOpeningFixture();
    courseId = randomUUID();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug)
      VALUES (${courseId},${fixture.scope.workspaceId},'Activation',${courseId})`;
  });
  afterEach(async () => { await fixture.close(); });

  const read = () => readLearningAutomationState(fixture.sql, fixture.scope, courseId);
  const account = () => createWorkspacePreferencesRepository(fixture.sql);
  const tick = () => fixture.sql`SELECT pg_sleep(0.01)`;

  it("keeps account opt-in required and rejects foreign scope", async () => {
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, enabled);
    expect(await read()).toEqual({
      preferences: { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false },
      retestSuggestionsEnabledAt: null, automaticRemindersEnabledAt: null,
    });
    await expect(readLearningAutomationState(fixture.sql, fixture.otherScope, courseId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await account().setLearningPreferences(fixture.scope, enabled);
    expect(await read()).toMatchObject({
      preferences: enabled, retestSuggestionsEnabledAt: expect.any(Date), automaticRemindersEnabledAt: expect.any(Date),
    });
  });

  it("preserves activation through default entry, title and identical preference saves", async () => {
    await account().setLearningPreferences(fixture.scope, enabled);
    const original = await read();
    await tick();
    await account().setDefaultEntry(fixture.scope.workspaceId, "learn");
    await account().setLearningPreferences(fixture.scope, enabled);
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, enabled);
    await fixture.sql`UPDATE courses SET title='Renamed',updated_at=now() WHERE id=${courseId}`;
    expect(await read()).toEqual(original);
  });

  it("advances only the account behavior reopened and both after assessment reopens", async () => {
    await account().setLearningPreferences(fixture.scope, enabled);
    const original = await read();
    await account().setLearningPreferences(fixture.scope, { ...enabled, retestSuggestionsEnabled: false });
    expect((await read()).retestSuggestionsEnabledAt).toBeNull();
    await tick();
    await account().setLearningPreferences(fixture.scope, enabled);
    const retestReopened = await read();
    expect(retestReopened.retestSuggestionsEnabledAt!.getTime()).toBeGreaterThan(original.retestSuggestionsEnabledAt!.getTime());
    expect(retestReopened.automaticRemindersEnabledAt).toEqual(original.automaticRemindersEnabledAt);
    await account().setLearningPreferences(fixture.scope, { ...enabled, automaticRemindersEnabled: false });
    expect((await read()).automaticRemindersEnabledAt).toBeNull();
    await tick();
    await account().setLearningPreferences(fixture.scope, enabled);
    const remindersReopened = await read();
    expect(remindersReopened.retestSuggestionsEnabledAt).toEqual(retestReopened.retestSuggestionsEnabledAt);
    expect(remindersReopened.automaticRemindersEnabledAt!.getTime()).toBeGreaterThan(original.automaticRemindersEnabledAt!.getTime());
    await account().setLearningPreferences(fixture.scope, { ...enabled, assessmentEnabled: false });
    expect(await read()).toMatchObject({ retestSuggestionsEnabledAt: null, automaticRemindersEnabledAt: null });
    await tick();
    await account().setLearningPreferences(fixture.scope, enabled);
    const assessmentReopened = await read();
    expect(assessmentReopened.retestSuggestionsEnabledAt!.getTime()).toBeGreaterThan(retestReopened.retestSuggestionsEnabledAt!.getTime());
    expect(assessmentReopened.automaticRemindersEnabledAt!.getTime()).toBeGreaterThan(remindersReopened.automaticRemindersEnabledAt!.getTime());
  });

  it("advances course permissions independently, including assessment and direct archive restore", async () => {
    await account().setLearningPreferences(fixture.scope, enabled);
    const original = await read();
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { retestSuggestionsEnabled: false });
    await tick();
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { retestSuggestionsEnabled: true });
    const reopened = await read();
    expect(reopened.retestSuggestionsEnabledAt!.getTime()).toBeGreaterThan(original.retestSuggestionsEnabledAt!.getTime());
    expect(reopened.automaticRemindersEnabledAt).toEqual(original.automaticRemindersEnabledAt);
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { automaticRemindersEnabled: false });
    await tick();
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { automaticRemindersEnabled: true });
    const remindersReopened = await read();
    expect(remindersReopened.retestSuggestionsEnabledAt).toEqual(reopened.retestSuggestionsEnabledAt);
    expect(remindersReopened.automaticRemindersEnabledAt!.getTime()).toBeGreaterThan(original.automaticRemindersEnabledAt!.getTime());
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { assessmentEnabled: false });
    await tick();
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { assessmentEnabled: true });
    const assessmentReopened = await read();
    expect(assessmentReopened.retestSuggestionsEnabledAt!.getTime()).toBeGreaterThan(reopened.retestSuggestionsEnabledAt!.getTime());
    expect(assessmentReopened.automaticRemindersEnabledAt!.getTime()).toBeGreaterThan(remindersReopened.automaticRemindersEnabledAt!.getTime());
    await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    expect(await read()).toMatchObject({ retestSuggestionsEnabledAt: null, automaticRemindersEnabledAt: null });
    await tick();
    await fixture.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`;
    const restored = await read();
    expect(restored.retestSuggestionsEnabledAt!.getTime()).toBeGreaterThan(assessmentReopened.retestSuggestionsEnabledAt!.getTime());
    expect(restored.automaticRemindersEnabledAt!.getTime()).toBeGreaterThan(assessmentReopened.automaticRemindersEnabledAt!.getTime());
  });

  it("uses the later account or course activation even when the other scope is disabled", async () => {
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { assessmentEnabled: false });
    await account().setLearningPreferences(fixture.scope, enabled);
    expect((await read()).retestSuggestionsEnabledAt).toBeNull();
    await tick();
    await setCourseLearningPreferences(fixture.sql, fixture.scope, courseId, { assessmentEnabled: true });
    const courseLater = await read();
    const [local] = await fixture.sql`SELECT retest_suggestions_enabled_at,automatic_reminders_enabled_at
      FROM courses WHERE id=${courseId}`;
    expect(courseLater.retestSuggestionsEnabledAt).toEqual(local!.retest_suggestions_enabled_at);
    expect(courseLater.automaticRemindersEnabledAt).toEqual(local!.automatic_reminders_enabled_at);
    await account().setLearningPreferences(fixture.scope, { ...enabled, assessmentEnabled: false });
    await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    await fixture.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`;
    await tick();
    await account().setLearningPreferences(fixture.scope, enabled);
    const accountLater = await read();
    const [global] = await fixture.sql`SELECT retest_suggestions_enabled_at,automatic_reminders_enabled_at
      FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(accountLater.retestSuggestionsEnabledAt).toEqual(global!.retest_suggestions_enabled_at);
    expect(accountLater.automaticRemindersEnabledAt).toEqual(global!.automatic_reminders_enabled_at);
  });

  it("serializes direct archive with a consumer and preserves a concurrent account update", async () => {
    await account().setLearningPreferences(fixture.scope, enabled);
    await read();
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { locked = resolve; });
    const consumer = fixture.sql.begin(async (tx) => {
      await lockLearningPreferences(tx, fixture.scope, courseId);
      expect((await readLearningAutomationState(tx, fixture.scope, courseId)).preferences).toEqual(enabled);
      locked();
      await hold;
    });
    await entered;
    let archived = false;
    const writer = fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`
      .then(() => { archived = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(archived).toBe(false);
    } finally { release(); }
    await Promise.all([consumer, writer]);
    await Promise.all([
      account().setLearningPreferences(fixture.scope, { ...enabled, retestSuggestionsEnabled: false }),
      fixture.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`,
    ]);
    expect(await read()).toMatchObject({
      preferences: { ...enabled, retestSuggestionsEnabled: false },
      retestSuggestionsEnabledAt: null, automaticRemindersEnabledAt: expect.any(Date),
    });
  });

  it("backfills existing active rows with their prior cutoff without opting in disabled rows", async () => {
    const migration = await readFile(new URL("../../packages/database/src/migrations/0032_opening_learning_activation.sql", import.meta.url), "utf8");
    const schema = `activation_${randomUUID().replaceAll("-", "")}`;
    await fixture.sql.begin(async (tx) => {
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      await tx`CREATE TABLE workspace_preferences (id integer,assessment_enabled boolean,
        retest_suggestions_enabled boolean,automatic_reminders_enabled boolean,updated_at timestamptz)`;
      await tx`CREATE TABLE courses (id integer,assessment_enabled boolean,retest_suggestions_enabled boolean,
        automatic_reminders_enabled boolean,archived_at timestamptz,updated_at timestamptz)`;
      await tx`INSERT INTO workspace_preferences VALUES
        (1,true,true,true,'2026-01-01'),(2,NULL,NULL,NULL,'2026-01-02'),(3,false,true,true,'2026-01-03')`;
      await tx`INSERT INTO courses VALUES
        (1,NULL,NULL,NULL,NULL,'2026-02-01'),(2,false,NULL,NULL,NULL,'2026-02-02'),
        (3,NULL,NULL,NULL,'2026-02-03','2026-02-03'),(4,NULL,false,NULL,NULL,'2026-02-04')`;
      await tx.unsafe(migration);
      const global = await tx`SELECT retest_suggestions_enabled_at,automatic_reminders_enabled_at FROM workspace_preferences ORDER BY id`;
      const local = await tx`SELECT retest_suggestions_enabled_at,automatic_reminders_enabled_at FROM courses ORDER BY id`;
      expect(global.map((row) => [row.retest_suggestions_enabled_at, row.automatic_reminders_enabled_at])).toEqual([
        [new Date("2026-01-01Z"), new Date("2026-01-01Z")], [null, null], [null, null],
      ]);
      expect(local.map((row) => [row.retest_suggestions_enabled_at, row.automatic_reminders_enabled_at])).toEqual([
        [new Date("2026-02-01Z"), new Date("2026-02-01Z")], [null, null], [null, null],
        [null, new Date("2026-02-04Z")],
      ]);
      await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    });
  });
});
