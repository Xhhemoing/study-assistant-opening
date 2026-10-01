import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningPlansRepository, createOpeningRetestRepository, createWorkspacePreferencesRepository, readOpeningRetestReviewCandidates, reviseOpeningLearningObservation } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations,opening_tasks CASCADE`; });
afterAll(async () => { await fixture?.close(); });
function beforeCommit(sql: Sql) {
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const gated = new Proxy(sql, { get(target, property) {
    return property === "begin" ? (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => {
      const result = await work(tx); entered(); await barrier; return result;
    }) : Reflect.get(target,property);
  } });
  return { sql:gated, release, opened };
}
async function setup() {
  const f=await learningAttemptFixture(fixture), original=await f.submit(await f.start()), candidateId=randomUUID();
  await createWorkspacePreferencesRepository(fixture.sql).setLearningPreferences(fixture.scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
  await createOpeningRetestRepository(fixture.sql).saveCandidates(fixture.scope,[{ id:candidateId,courseId:f.courseId,skillLabel:"fractions",sourceIds:[f.sourceId],
    dueAt:"2026-09-29T10:00:00Z",prompt:"Try again",accepted:false,kind:"task",evidenceRootIds:[original.id],evidenceObservationIds:[original.id] }]);
  const input={ title:"Try again",minutes:20,dueAt:null,priority:1,candidateId,clientKey:randomUUID(),inputSnapshot:{kind:"retest" as const,candidateId,heuristic:true as const} };
  const correction={rootObservationId:original.id,revisesObservationId:original.id,expectedHead:original.id,revisionKind:"retract" as const,reason:"Wrong observation",clientKey:randomUUID()};
  return {f,original,candidateId,input,correction};
}
it.each(["revise","accept"] as const)("coordinates acceptance and correction with %s committing first",async first => {
  const seed=await setup(), a=await openRaceSession().ready,b=await openRaceSession().ready,barrier=beforeCommit(a.sql);
  const revise=(sql:Sql)=>reviseOpeningLearningObservation(sql,fixture.scope,seed.correction);
  const accept=(sql:Sql)=>createOpeningPlansRepository(sql).createTask(fixture.scope,seed.input);
  const winner=track<unknown>(first==="revise"?revise(barrier.sql):accept(barrier.sql)),pending:Promise<unknown>[]=[winner];
  try {
    await Promise.race([barrier.opened,winner.then(()=>{throw new Error("commit barrier bypassed");})]);
    const loser=track<unknown>(first==="revise"?accept(b.sql):revise(b.sql)); pending.push(loser);
    await waitUntilBlocked(fixture.sql,b.pid,a.pid,"evidence history",/opening_(?:workspace_|learning_)history_revisions/);
    barrier.release();await winner;
    if(first==="revise") await expect(loser).rejects.toMatchObject({code:"NOT_FOUND"}); else await loser;
    const [row]=await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${seed.candidateId}`;
    expect(row?.payload).toMatchObject(first==="revise"?{invalidated:true,accepted:false}:{accepted:true,evidenceChanged:true});
    expect(await fixture.sql`SELECT id FROM opening_tasks`).toHaveLength(first==="accept"?1:0);
    expect(await readOpeningRetestReviewCandidates(fixture.sql,fixture.scope)).toEqual([]);
    if(first==="accept") expect((await accept(b.sql)).id).toBe((await accept(a.sql)).id);
  } finally { barrier.release();await Promise.allSettled(pending);await closeRace(b.sql);await closeRace(a.sql); }
},15_000);
it("rolls back the append, head, watermarks and candidate invalidation on transaction failure",async()=>{
  const seed=await setup();
  const failing=new Proxy(fixture.sql,{get(target,property){return property==="begin"?(work:(tx:TransactionSql)=>Promise<unknown>)=>target.begin(async tx=>{
    await work(tx);throw new Error("abort before commit");
  }):Reflect.get(target,property);}});
  await expect(reviseOpeningLearningObservation(failing,fixture.scope,seed.correction)).rejects.toThrow("abort before commit");
  expect(await fixture.sql`SELECT id,effective_head_id FROM opening_learning_observations WHERE root_observation_id=${seed.original.id}`).toMatchObject([{id:seed.original.id,effective_head_id:seed.original.id}]);
  expect(await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${seed.f.courseId}`).toMatchObject([{revision:String(seed.original.historyRevision)}]);
  const [job]=await fixture.sql`SELECT payload FROM opening_jobs WHERE id=${seed.candidateId}`;
  expect(job?.payload.invalidated).toBeUndefined();expect(await readOpeningRetestReviewCandidates(fixture.sql,fixture.scope)).toHaveLength(1);
});
