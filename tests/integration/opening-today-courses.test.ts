import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readOpeningTodayCourses } from "@aistudy/database";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });
it("reads only the owning workspace and counts archived courses as existing courses", async () => {
  expect(await readOpeningTodayCourses(fixture.sql, fixture.scope)).toEqual([]);
  const id = randomUUID(), foreign = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug,archived_at) VALUES
    (${id},${fixture.scope.workspaceId},'真实归档课程',${id},now()),
    (${foreign},${fixture.otherScope.workspaceId},'他人课程',${foreign},NULL)`;
  const rows = await readOpeningTodayCourses(fixture.sql, fixture.scope);
  expect(rows).toEqual([{ id, title: "真实归档课程", archivedAt: expect.any(String) }]);
  await expect(readOpeningTodayCourses(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("reads the owner's goal and omits unreadable stored goals without inventing defaults", async () => {
  const id = randomUUID();
  await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${id},${fixture.scope.workspaceId},'线性代数',${id})`;
  const goal = { targetDate: "2026-10-31", weeklyMinutes: 420, learningMode: "auto" };
  const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [id]: goal } };
  await fixture.sql`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES (${fixture.scope.workspaceId},${fixture.sql.json(prefs)})
    ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning`;
  expect((await readOpeningTodayCourses(fixture.sql, fixture.scope)).find(course => course.id === id))
    .toEqual({ id, title: "线性代数", archivedAt: null, ...goal });
  expect((await readOpeningTodayCourses(fixture.sql, fixture.otherScope)).some(course => course.id === id)).toBe(false);
  await fixture.sql`UPDATE workspace_preferences SET adaptive_planning=${fixture.sql.json({ ...prefs, courseGoals: { [id]: { ...goal, weeklyMinutes: "broken" } } })}
    WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect((await readOpeningTodayCourses(fixture.sql, fixture.scope)).find(course => course.id === id))
    .toEqual({ id, title: "线性代数", archivedAt: null });
});
