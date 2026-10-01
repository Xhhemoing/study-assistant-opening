import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readOpeningCourseLearningSummary, repairOpeningLearningEligibility } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => {
  if (!fixture) return;
  try {
    const scopes=[fixture.scope.workspaceId,fixture.otherScope.workspaceId],users=[fixture.scope.ownerUserId,fixture.otherScope.ownerUserId];
    await fixture.sql.begin(async tx=> {
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
/** Pause at the real transaction boundary after batch capture, before any install lock. */
function pauseInstallation(sql: Sql) {
  let ready!:()=>void,resume!:()=>void;
  const captured=new Promise<void>(resolve=>{ready=resolve;}),released=new Promise<void>(resolve=>{resume=resolve;});
  const wrapped=new Proxy(sql,{get(target,key,receiver){
    if(key!=="begin") return Reflect.get(target,key,receiver);
    return async (...args:unknown[])=>{
      if(typeof args[0]==="function") {ready();await released;}
      return Reflect.apply(target.begin,target,args);
    };
  }}) as Sql;
  return {sql:wrapped,captured,resume};
}
it("rejects a delayed absent-row repair after a real help writer invalidated zero rows", async()=>{
  const f=await learningAttemptFixture(fixture),attempt=await f.start(),observation=await f.submit(attempt);
  await fixture.sql`DELETE FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`;
  const pause=pauseInstallation(fixture.sql);
  const repair=repairOpeningLearningEligibility(pause.sql,fixture.scope,{courseId:f.courseId,groups:[{skillLabel:"fractions",requirementKey:null}]});
  try {await pause.captured;await f.help(attempt);} finally {pause.resume();}
  expect(await repair).toBe(0);
  expect(await fixture.sql`SELECT 1 FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`).toHaveLength(0);
  const page=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
  expect(page.status).toBe("ready");expect(page.groups[0]?.sampleCount).toBe(1);
});
it("checks live dependency values even when a restore-style source change bypasses the semantic counter", async()=>{
  const f=await learningAttemptFixture(fixture),observation=await f.submit(await f.start());
  await fixture.sql`DELETE FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`;
  const pause=pauseInstallation(fixture.sql);
  const repair=repairOpeningLearningEligibility(pause.sql,fixture.scope,{courseId:f.courseId,groups:[{skillLabel:"fractions",requirementKey:null}]});
  try {await pause.captured;await fixture.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${f.sourceId}`;} finally {pause.resume();}
  expect(await repair).toBe(0);
  const page=await readOpeningCourseLearningSummary(fixture.sql,fixture.scope,{courseId:f.courseId,limit:10});
  expect(page.groups[0]?.representatives[0]?.versionApplicability).toBe("unavailable");
});
it("reports only actual CAS installs when two requests rebuild the same missing head",async()=>{
  const f=await learningAttemptFixture(fixture),observation=await f.submit(await f.start());
  await fixture.sql`DELETE FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`;
  const pause=pauseInstallation(fixture.sql),filter={courseId:f.courseId,groups:[{skillLabel:"fractions",requirementKey:null}]};
  const older=repairOpeningLearningEligibility(pause.sql,fixture.scope,filter);
  let newer=0;
  try {await pause.captured;newer=await repairOpeningLearningEligibility(fixture.sql,fixture.scope,filter);} finally {pause.resume();}
  expect(newer).toBe(1);expect(await older).toBe(0);
  expect(await fixture.sql`SELECT 1 FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`).toHaveLength(1);
});
