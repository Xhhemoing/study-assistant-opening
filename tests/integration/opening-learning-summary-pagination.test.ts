import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningRetestActivityRepository, readOpeningCourseLearningSummary } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => {
  if (!fixture) return;
  try {
    const scopes=[fixture.scope.workspaceId,fixture.otherScope.workspaceId],users=[fixture.scope.ownerUserId,fixture.otherScope.ownerUserId];
    await fixture.sql.begin(async tx=> {
      await tx`DELETE FROM opening_retest_activities WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_turns WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_learning_sessions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_learning_item_versions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_learning_history_revisions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM opening_source_versions WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM courses WHERE workspace_id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM workspaces WHERE id=ANY(${scopes}::uuid[])`;
      await tx`DELETE FROM sessions WHERE user_id=ANY(${users}::uuid[])`;
      await tx`DELETE FROM users WHERE id=ANY(${users}::uuid[])`;
    });
  } finally { await fixture.close(); }
});
it("paginates stable null, empty and named groups and rejects changed semantic inputs", async () => {
  const f=await learningAttemptFixture(fixture);
  const attempts=[];
  for (const requirementKey of [null,"","named"]) {
    const attempt=await f.start({requirementKey}); attempts.push(attempt); await f.submit(attempt);
  }
  const first=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:1});
  expect(first.groups.map(group=>group.identity.requirementKey)).toEqual([null]);
  await fixture.sql`DELETE FROM opening_learning_eligibility WHERE workspace_id=${fixture.scope.workspaceId}`;
  const second=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:1,groupCursor:first.nextCursor!});
  expect(second.groups.map(group=>group.identity.requirementKey)).toEqual([""]);
  expect(second.snapshotRevision).toBe(first.snapshotRevision); expect(second.evaluatedAt).toBe(first.evaluatedAt);
  const third=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:1,groupCursor:second.nextCursor!});
  expect(third.groups.map(group=>group.identity.requirementKey)).toEqual(["named"]); expect(third.nextCursor).toBeNull();
  await f.help(attempts[0]!);
  await expect(readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:1,groupCursor:first.nextCursor!})).rejects.toMatchObject({code:"CONFLICT"});
  await expect(readOpeningCourseLearningSummary(fixture.sql,fixture.otherScope,{courseId:f.courseId,limit:1})).rejects.toMatchObject({code:"NOT_FOUND"});
});
it("includes visible native activity-only groups and pins due evaluation to the traversal", async () => {
  const f=await learningAttemptFixture(fixture), taskId=randomUUID();
  await fixture.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,due_at,priority,status,version)
    VALUES(${taskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'Retest',15,NULL,1,'pending',1)`;
  const activities=createOpeningRetestActivityRepository(fixture.sql);
  const proposed=await activities.createProposed(fixture.scope,{cycleId:randomUUID(),courseId:f.courseId,skillLabel:"activity only",requirementKey:"practice",recommendedAt:"2026-01-01T00:00:00.000Z"});
  await activities.accept(fixture.scope,proposed.activityId,taskId,"2026-01-01T00:00:00.000Z");
  const page=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
  expect(page.groups).toHaveLength(1);
  expect(page.groups[0]).toMatchObject({sampleCount:0,lastObservedAt:null,latestAttemptAt:null,representatives:[],openChecks:{acceptedCount:1,inProgressCount:0,dueCount:1}});
});
it("counts every historical outcome before limiting displayed representatives", async () => {
  const f=await learningAttemptFixture(fixture);
  const checked={verdictSource:"reference_checked",referenceSourceId:f.sourceId,referenceCheck:{referenceSourceId:f.sourceId,method:"manual_reference",scope:"whole_answer"}};
  for(let index=0;index<24;index++) await f.submit(await f.start({requirementKey:"addition"}),{...checked,outcome:index<5?"incorrect":"correct"});
  const page=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
  expect(page.groups[0]).toMatchObject({sampleCount:24,historicalIncorrectCount:5,independentVerifiedCurrentCount:19,latestIndependentVerifiedCurrentCount:1});
  expect(page.groups[0]?.representatives).toHaveLength(20);
});
