import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readOpeningTodayCourses } from "@aistudy/database";
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
