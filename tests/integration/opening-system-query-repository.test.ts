import { randomUUID } from "node:crypto";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import type { TransactionSql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopedOpeningSystemQueryReader, createOpeningTeachingContentRepository, readOpeningSystemQueryAuthorization, createLibraryRepository, createCardRepository, createOpeningExamSprintRepository } from "@aistudy/database";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, DEFAULT_OPENING_AI_SETTINGS, systemQueryRequestSchema, type SystemQueryResult } from "@aistudy/contracts";
import { runSystemQuery, renderSystemQuery } from "@aistudy/ai";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { refreshOpeningLearningEligibility, openingEligibilityStateQuery } from "../../packages/database/src/repositories/opening-learning-eligibility";
import { contextSourceRefsIncluded } from "../../packages/database/src/repositories/opening-context-provenance";

let fixture: OpeningFixture;
const signal = () => new AbortController().signal;
const read = (request: unknown) => createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope, { purpose: "source_review" })(systemQueryRequestSchema.parse(request), signal());
async function publishTeaching(f: Awaited<ReturnType<typeof learningAttemptFixture>>) {
  const [activity] = await fixture.sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${f.sessionId}`;
  const content = createOpeningTeachingContentRepository(fixture.sql), blockId = randomUUID();
  const unit = await content.createUnit(fixture.scope, { title: "Query fixture unit", blocks: [{ id: blockId, type: "text", content: { markdown: "Fixture teaching content" } }] });
  await content.publishActivitySpec(fixture.scope, { activityId: String(activity!.activity_id), teachingUnitId: unit.id, expectedVersion: 0,
    revisionNumber: unit.currentRevisionNumber, expectedRevisionNumber: unit.currentRevisionNumber,
    blockOrder: [{ blockId, blockType: "text", role: "teach", position: 0 }], sourceRefs: [{ sourceId: f.sourceId, version: 1 }] });
}
beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try {
    // Isolated test DB only: preserve production append-only guards while clearing library fixtures.
    await fixture.sql`TRUNCATE library_documents CASCADE`;
    const workspaces = [fixture.scope.workspaceId, fixture.otherScope.workspaceId], users = [fixture.scope.ownerUserId, fixture.otherScope.ownerUserId];
    await fixture.sql`UPDATE opening_turns SET attempt_id=NULL,learning_session_id=NULL WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM opening_learning_sessions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM opening_learning_item_versions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM courses WHERE workspace_id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM workspaces WHERE id=ANY(${workspaces}::uuid[])`;
    await fixture.sql`DELETE FROM sessions WHERE user_id=ANY(${users}::uuid[])`;
    await fixture.sql`DELETE FROM users WHERE id=ANY(${users}::uuid[])`;
  } finally { await fixture.close(); }
});

describe("owned read-only system query against PostgreSQL", () => {
  it("binds the server owner grant and purpose, withholding source and answer bodies in record lookup", async () => {
    const f = await learningAttemptFixture(fixture); await f.submit(await f.start());
    const bound = await readOpeningSystemQueryAuthorization(fixture.sql, fixture.scope);
    expect(bound.authorization).toMatchObject({ workspaceId: fixture.scope.workspaceId, principalId: fixture.scope.ownerUserId, purpose: "system_record_lookup", role: "workspace_owner" });
    const reader = createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope);
    const material = await reader(systemQueryRequestSchema.parse({ name: "materials", arguments: { sourceId: f.sourceId } }), signal());
    expect(material.authorization).toEqual(bound.authorization);
    expect(material.data[0]).toMatchObject({ exposure: "content_withheld", physicalPage: 1 });
    expect(material.data[0]).not.toHaveProperty("excerpt");
    const learning = await reader(systemQueryRequestSchema.parse({ name: "learning", arguments: { courseId: f.courseId } }), signal());
    expect(learning.data[0]).toMatchObject({ answerWithheld: true });
    expect(learning.data[0]).not.toHaveProperty("answerExcerpt");
    expect(systemQueryRequestSchema.safeParse({ name: "materials", arguments: { sourceId: f.sourceId, purpose: "source_review" } }).success).toBe(false);
  });
  it.each(["changed", "unavailable", "unknown_capture"])("refuses invalid ancestor versions (%s) even when the current head projection is fresh", async invalid => {
    const f = await learningAttemptFixture(fixture), observation = await f.submit(await f.start());
    await f.learning.reviseObservation(fixture.scope, { rootObservationId: observation.id, revisesObservationId: observation.id, expectedHead: observation.id,
      revisionKind: "replace", reason: "new answer", clientKey: randomUUID(), replacement: { answer: "PRIVATE_REVISED_ANSWER", outcome: "unverified", assistance: "independent" } });
    const ancestor = await backupRows(fixture.sql, fixture.scope).source();
    // Seed a historical reference removed from today's head, then rebuild the existing projection explicitly in fixture setup.
    await fixture.sql`UPDATE opening_learning_observations SET reference_source_id=${ancestor},source_versions=source_versions||${JSON.stringify({ [ancestor]: 1 })}::text::jsonb WHERE id=${observation.id}`;
    await fixture.sql.begin(tx => refreshOpeningLearningEligibility(tx, fixture.scope, [observation.id]));
    if (invalid === "changed") await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${ancestor}`;
    if (invalid === "unavailable") await fixture.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,availability) VALUES (${ancestor},1,${fixture.scope.workspaceId},'unavailable')`;
    if (invalid === "unknown_capture") await fixture.sql`UPDATE opening_learning_observations SET source_versions=source_versions-${ancestor}::text WHERE id=${observation.id}`;
    const [head] = await openingEligibilityStateQuery(fixture.sql, fixture.scope, { rootIds: [observation.id] });
    expect(head?.fresh).toBe(true);
    const result = await read({ name: "learning", arguments: { courseId: f.courseId } });
    expect(result).toMatchObject({ status: "unknown", reason: "not_available", data: [], evidence: [], sourceRefs: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REVISED_ANSWER");
  });
  it("invalidates AI context for unavailable source versions while preserving historical backup metadata", async () => {
    const sourceId = await backupRows(fixture.sql, fixture.scope).source();
    await fixture.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,availability) VALUES (${sourceId},1,${fixture.scope.workspaceId},'unavailable')`;
    const refs = fixture.sql`${JSON.stringify([{ sourceId, sourceVersion: 1 }])}::text::jsonb`;
    const [admission] = await fixture.sql`SELECT ${contextSourceRefsIncluded(fixture.sql, fixture.scope.workspaceId, refs)} AS ai,
      ${contextSourceRefsIncluded(fixture.sql, fixture.scope.workspaceId, refs, true)} AS backup`;
    expect(admission).toMatchObject({ ai: false, backup: true });
  });
  it("executes every registered tool in enforced read-only transactions with zero row writes", async () => {
    const f = await learningAttemptFixture(fixture); await f.submit(await f.start());
    let checked = 0;
    const observedSql = new Proxy(fixture.sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (mode: string, execute: (tx: TransactionSql) => Promise<SystemQueryResult>) => target.begin(mode, async tx => {
        const [before] = await tx`SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int AS writes FROM pg_stat_xact_user_tables`;
        const result = await execute(tx);
        const [state] = await tx`SELECT current_setting('transaction_read_only') AS read_only,
          (SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int FROM pg_stat_xact_user_tables) AS writes`;
        expect(state?.read_only).toBe("on");
        expect(Number(state?.writes) - Number(before?.writes)).toBe(0); checked++;
        return result;
      });
    } });
    const reader = createScopedOpeningSystemQueryReader(observedSql, fixture.scope);
    for (const name of systemQueryRequestSchema.options.map(option => option.shape.name.value)) {
      const args = ["learning", "recommendation", "teaching"].includes(name) ? { courseId: f.courseId } : name === "materials" ? { sourceId: f.sourceId } : name === "explain_decision" ? { decisionId: randomUUID() } : {};
      await reader(systemQueryRequestSchema.parse({ name, arguments: args }), signal());
    }
    expect(checked).toBe(systemQueryRequestSchema.options.length * 2);
  });
  it("reads persisted note/card metadata without releasing their bodies and rechecks source versions", async () => {
    const f = await learningAttemptFixture(fixture);
    const note = await createLibraryRepository(fixture.sql).createDocument({ workspaceId: fixture.scope.workspaceId, title: "线性张成笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "PRIVATE_NOTE_SOLUTION" } }] });
    await fixture.sql`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
      VALUES(${note.id},${fixture.scope.workspaceId},${fixture.sql.json([{ sourceId: f.sourceId, sourceVersion: 1 }])})`;
    const card = await createCardRepository(fixture.sql).createCard({ ...fixture.scope, front: "PRIVATE_FRONT", back: "PRIVATE_CARD_ANSWER", sourceDocumentId: note.id, courseId: f.courseId });
    const notes = await read({ name: "notes", arguments: { query: "张成" } });
    const cards = await read({ name: "cards", arguments: { courseId: f.courseId } });
    expect(notes.data[0]).toMatchObject({ id: note.id, title: "线性张成笔记", revision: 1, contentWithheld: true });
    expect(cards.data[0]).toMatchObject({ id: card.id, contentVersion: 1, answerWithheld: true });
    expect(notes.sourceRefs).toEqual([{ sourceId: f.sourceId, sourceVersion: 1 }]);
    expect(JSON.stringify([notes, cards])).not.toMatch(/PRIVATE_NOTE_SOLUTION|PRIVATE_CARD_ANSWER|PRIVATE_FRONT/);
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
    expect(await read({ name: "notes", arguments: {} })).toMatchObject({ status: "unknown", data: [] });
    expect(await read({ name: "cards", arguments: {} })).toMatchObject({ status: "unknown", data: [] });
  });
  it("reads persisted sprint counts and learner-state versions without becoming a repair or grading path", async () => {
    const f = await learningAttemptFixture(fixture); await f.submit(await f.start());
    await createOpeningExamSprintRepository(fixture.sql, EXAM_SPRINT_PACK).act(fixture.scope, { action: "configure", examDate: "2026-11-01", dailyMinutes: 30, clientKey: randomUUID() });
    const sprint = await read({ name: "exam_sprint", arguments: {} });
    expect(sprint).toMatchObject({ status: "partial", data: [{ examDate: "2026-11-01", attemptCount: 0, completedCount: 0, basis: "stored_snapshot" }] });
    expect(JSON.stringify(sprint)).not.toContain(EXAM_SPRINT_PACK.questions[0]!.explanation);
    const state = await read({ name: "learner_state", arguments: { courseId: f.courseId, limit: 1 } });
    expect(state.data[0]).toMatchObject({ stateVersion: expect.any(String), dataAsOf: expect.any(String) });
    expect(state.sourceRefs).toEqual([{ sourceId: f.sourceId, sourceVersion: 1 }]);
    expect(await read({ name: "explain_decision", arguments: { decisionId: randomUUID() } })).toMatchObject({ status: "unknown", reason: "no_data", data: [] });
  });
  it("reads courses and validated goal fields, caps pagination and rejects a forged server scope", async () => {
    const id = randomUUID();
    for (const [scope, title] of [[fixture.scope, "数学 A"], [fixture.scope, "数学 B"], [fixture.otherScope, "PRIVATE COURSE"]] as const) {
      await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${title === "数学 A" ? id : randomUUID()},${scope.workspaceId},${title},${randomUUID()})`;
    }
    const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [id]: { targetDate: "2026-11-01", weeklyMinutes: 90 } } };
    await fixture.sql`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES (${fixture.scope.workspaceId},${fixture.sql.json(prefs)})`;
    const page = await read({ name: "courses", arguments: { limit: 1 } });
    expect(page).toMatchObject({ status: "partial", reason: "truncated", nextOffset: 1 });
    expect(page.data[0]).toMatchObject({ id, goal: { targetDate: "2026-11-01", weeklyMinutes: 90 } });
    expect(JSON.stringify(page)).not.toContain("PRIVATE COURSE");
    await expect(createScopedOpeningSystemQueryReader(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId })(systemQueryRequestSchema.parse({ name: "courses", arguments: {} }), signal())).rejects.toThrow("privacy changed");
  });
  it("reads fresh qualifications and answer identity without promoting self-report to verified success", async () => {
    const f = await learningAttemptFixture(fixture), observation = await f.submit(await f.start());
    const result = await read({ name: "learning", arguments: { courseId: f.courseId } });
    expect(result.status).toBe("ok");
    expect(result.data[0]).toMatchObject({ id: observation.id, attemptId: observation.attemptId, itemVersionId: observation.itemVersionId,
      answerExcerpt: "1", projectionFresh: true, eligibility: { independentAttempt: "yes", verifiedCorrect: "unknown", policyVersion: "opening-evidence-v3" } });
    expect(result.evidence[0]).toMatchObject({ recordId: observation.id, attemptId: observation.attemptId });
    expect(result.sourceRefs).toContainEqual({ sourceId: f.sourceId, sourceVersion: 1 });
    expect(await read({ name: "learning", arguments: { courseId: randomUUID() } })).toMatchObject({ status: "unknown", reason: "not_available", data: [] });
  });
  it("does not repair a stale source/policy projection or expose source-derived answer text", async () => {
    const f = await learningAttemptFixture(fixture), observation = await f.submit(await f.start());
    await fixture.sql`UPDATE opening_learning_eligibility SET policy_version='old-policy' WHERE root_observation_id=${observation.id}`;
    await fixture.sql`UPDATE opening_sources SET version=version+1 WHERE id=${f.sourceId}`;
    const result = await read({ name: "learning", arguments: { courseId: f.courseId } });
    expect(result).toMatchObject({ status: "unknown", reason: "stale", data: [], evidence: [], sourceRefs: [] });
    const [projection] = await fixture.sql`SELECT policy_version FROM opening_learning_eligibility WHERE root_observation_id=${observation.id}`;
    expect(projection?.policy_version).toBe("old-policy");
  });
  it("uses live delivered-help dependencies and excludes a revoked ancestor even after a revision", async () => {
    const f = await learningAttemptFixture(fixture), attempt = await f.start();
    await f.help(attempt, "revealed");
    const observation = await f.submit(attempt);
    const current = await read({ name: "learning", arguments: { courseId: f.courseId } });
    expect(current.data[0]).toMatchObject({ effectiveAssistance: "revealed", eligibility: { independentAttempt: "no" } });
    expect(Number(current.data[0]?.liveHelpRevision)).toBeGreaterThan(0);
    await f.learning.reviseObservation(fixture.scope, { rootObservationId: observation.id, revisesObservationId: observation.id, expectedHead: observation.id,
      revisionKind: "replace", reason: "correcting text", clientKey: randomUUID(), replacement: { answer: "revised private answer", outcome: "unverified", assistance: "independent" } });
    await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
    const excluded = await read({ name: "learning", arguments: { courseId: f.courseId } });
    expect(excluded).toMatchObject({ status: "unknown", reason: "no_data", data: [], evidence: [], sourceRefs: [] });
    expect(JSON.stringify(excluded)).not.toContain("revised private answer");
  });
  it("uses the shared next-step rule with explicit limits, and refuses inference from a truncated course", async () => {
    const f = await learningAttemptFixture(fixture); await f.submit(await f.start());
    const result = await read({ name: "recommendation", arguments: { courseId: f.courseId } });
    expect(result).toMatchObject({ status: "partial", reason: "not_available" });
    expect(result.data[0]).toMatchObject({ step: { activityKind: "diagnose", reasonCode: "unverified_only" } });
    expect(result.data[0]?.evidenceIds).toHaveLength(1);
    const receipt = await runSystemQuery({ ...await readOpeningSystemQueryAuthorization(fixture.sql, fixture.scope), question: "为什么建议我继续诊断？",
      read: createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope), assertCurrent: async () => {} });
    expect(receipt.results.map(row => row.name)).toEqual(["courses", "recommendation"]);
    expect(renderSystemQuery(receipt)).toContain("现有结果尚未核验");
    for (let index = 0; index < 10; index++) await f.submit(await f.start());
    const truncated = await read({ name: "recommendation", arguments: { courseId: f.courseId } });
    expect(truncated).toMatchObject({ status: "partial", reason: "truncated" });
    expect(truncated.data[0]).toMatchObject({ recommendationStatus: "unknown" });
    expect(truncated.data[0]).not.toHaveProperty("step");
  });
  it("returns current physical pages and exact lineage, with explicit excerpt limits and stale-version refusal", async () => {
    const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source(), chunkId = await rows.chunk(sourceId);
    await fixture.sql`UPDATE opening_source_chunks SET text=${"q".repeat(1300)} WHERE id=${chunkId}`;
    const result = await read({ name: "materials", arguments: { sourceId, sourceVersion: 1, physicalPage: 1 } });
    expect(result).toMatchObject({ status: "partial", reason: "truncated" });
    expect(result.data[0]).toMatchObject({ physicalPage: 1, sourceVersion: 1, truncated: true });
    expect(String(result.data[0]?.excerpt)).toHaveLength(1200);
    expect(result.evidence[0]).toMatchObject({ recordId: chunkId, sourceId, sourceVersion: 1, physicalPage: 1 });
    expect(result.evidence[0]?.href).toContain("&page=1");
    await fixture.sql`UPDATE opening_source_chunks SET text=${"😀".repeat(1000)} WHERE id=${chunkId}`;
    const emoji = await read({ name: "materials", arguments: { sourceId, physicalPage: 1 } });
    expect(emoji).toMatchObject({ status: "partial", reason: "truncated" });
    expect(emoji.data[0]?.excerpt).toBe("😀".repeat(600));
    expect(await read({ name: "materials", arguments: { sourceId, sourceVersion: 2 } })).toMatchObject({ status: "unknown", reason: "stale", data: [] });
    expect(await read({ name: "materials", arguments: {} })).toMatchObject({ status: "unknown", reason: "invalid_arguments" });
  });
  it("cannot read foreign/excluded/unavailable material or treat SQL wildcards as an instruction", async () => {
    const own = backupRows(fixture.sql, fixture.scope), foreign = backupRows(fixture.sql, fixture.otherScope);
    const privateSource = await foreign.source(); await foreign.chunk(privateSource);
    expect(await read({ name: "materials", arguments: { sourceId: privateSource } })).toMatchObject({ status: "unknown", data: [] });
    const sourceId = await own.source(); await own.chunk(sourceId);
    expect(await read({ name: "materials", arguments: { query: "%" } })).toMatchObject({ status: "unknown", reason: "no_data" });
    await own.exclude(sourceId);
    expect(await read({ name: "materials", arguments: { sourceId } })).toMatchObject({ status: "unknown", data: [] });
    const unavailable = await own.source(); await own.chunk(unavailable);
    await fixture.sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${unavailable}`;
    expect(await read({ name: "materials", arguments: { sourceId: unavailable } })).toMatchObject({ status: "unknown", data: [] });
  });
  it("reports real background and tutor job states without payloads, errors or claims about content quality", async () => {
    const own = backupRows(fixture.sql, fixture.scope), conversation = await own.conversation(), userTurn = await own.turn(conversation), assistantTurn = await own.turn(conversation);
    const background = randomUUID(), tutor = randomUUID();
    await fixture.sql`INSERT INTO opening_jobs(id,workspace_id,owner_user_id,key,kind,payload,state)
      VALUES (${background},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},${background},'parse','{"apiKey":"PRIVATE_PAYLOAD"}'::jsonb,'succeeded')`;
    await fixture.sql`INSERT INTO opening_tutor_jobs(id,workspace_id,conversation_id,user_turn_id,assistant_turn_id,status,mode)
      VALUES (${tutor},${fixture.scope.workspaceId},${conversation},${userTurn},${assistantTurn},'failed','listen')`;
    const result = await read({ name: "jobs", arguments: {} });
    expect(result.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: background, status: "succeeded" }), expect.objectContaining({ id: tutor, status: "failed" })]));
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PAYLOAD");
    const receipt = await runSystemQuery({ ...await readOpeningSystemQueryAuthorization(fixture.sql, fixture.scope), question: "后台任务成功了吗？", read: createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope), assertCurrent: async () => {} });
    expect(renderSystemQuery(receipt)).toContain(background);
    expect(renderSystemQuery(receipt)).toContain("不能证明内容质量或学习效果");
  });
  it.each([false, true])("shows only nonsecret saved routing and actual caller-process flags (planning=%s)", async enabled => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes: { "practice.grade-photo": { primary: null, fallback: null } } };
    await fixture.sql`INSERT INTO workspace_preferences(workspace_id,ai_settings) VALUES (${fixture.scope.workspaceId},${fixture.sql.json(settings)})`;
    const reader = createScopedOpeningSystemQueryReader(fixture.sql, fixture.scope, { publicSettings: () => ({ process: "web", adaptivePlanning: enabled, teachingLoop: true,
      apiKey: "PRIVATE_SECRET", internalPrompt: "PRIVATE_PROMPT" } as never) });
    const result = await reader(systemQueryRequestSchema.parse({ name: "settings", arguments: {} }), signal());
    expect(result.data[0]).toMatchObject({ process: "web", adaptivePlanning: enabled, taskRoutes: settings.taskRoutes });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(result.data[0]?.summary).toContain("未检测真实模型连通性或另一进程的配置");
    expect(await read({ name: "settings", arguments: {} })).toMatchObject({ status: "partial", reason: "not_available" });
  });
  it("reads accepted slots rather than generating/accepting a plan or exposing derived titles and reasons", async () => {
    const taskId = randomUUID();
    await fixture.sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,origin)
      VALUES (${taskId},${fixture.scope.workspaceId},${fixture.scope.ownerUserId},'PRIVATE_DERIVED_TITLE',30,'planner')`;
    const blocks = [{ taskId, start: "2026-10-19T10:00:00Z", end: "2026-10-19T10:30:00Z", reason: "PRIVATE_DERIVED_REASON" }];
    await fixture.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks)
      VALUES (${fixture.scope.workspaceId},'2026-10-19',4,${fixture.sql.json(blocks)})`;
    const result = await read({ name: "planning", arguments: { date: "2026-10-19" } });
    expect(result.data[0]).toMatchObject({ taskId, acceptedVersion: 4, title: "已确认学习任务" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DERIVED");
    expect(await read({ name: "planning", arguments: { date: "2026-10-20" } })).toMatchObject({ status: "unknown", reason: "no_data" });
    const [state] = await fixture.sql`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(state?.accepted_version).toBe(4);
  });
  it("distinguishes a never-accepted plan from an explicitly accepted empty plan", async () => {
    await fixture.sql`INSERT INTO opening_plan_state(workspace_id,day,accepted_version,accepted_blocks) VALUES (${fixture.scope.workspaceId},'2026-10-19',0,'[]'::jsonb)`;
    const draft = await read({ name: "planning", arguments: { date: "2026-10-19" } });
    expect(draft).toMatchObject({ status: "unknown", reason: "not_available", data: [] });
    await fixture.sql`UPDATE opening_plan_state SET accepted_version=1 WHERE workspace_id=${fixture.scope.workspaceId}`;
    const accepted = await read({ name: "planning", arguments: { date: "2026-10-19" } });
    expect(accepted.data[0]).toMatchObject({ acceptedVersion: 1, summary: expect.stringContaining("已确认计划为空") });
  });
  it("does not return data when cancellation occurs during the final permission read", async () => {
    const controller = new AbortController(); let transactions = 0;
    const observed = new Proxy(fixture.sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (mode: string, execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(mode, async tx => {
        const result = await execute(tx); if (++transactions === 2) controller.abort(); return result;
      });
    } });
    await expect(createScopedOpeningSystemQueryReader(observed, fixture.scope)(systemQueryRequestSchema.parse({ name: "settings", arguments: {} }), controller.signal)).rejects.toThrow("cancelled");
  });
  it("exposes teaching metadata without hidden answers, then removes activities tied to excluded sources", async () => {
    const f = await learningAttemptFixture(fixture);
    await publishTeaching(f);
    await fixture.sql`UPDATE opening_teaching_activities SET source_ids=${[f.sourceId]},intent_summary='PRIVATE_INTENT',goal_json='{"answer":"PRIVATE_ANSWER"}'::jsonb
      WHERE workspace_id=${fixture.scope.workspaceId}`;
    const result = await read({ name: "teaching", arguments: { courseId: f.courseId } });
    expect(result.data).toHaveLength(1);
    expect(result.sourceRefs).toContainEqual({ sourceId: f.sourceId, sourceVersion: 1 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    await backupRows(fixture.sql, fixture.scope).exclude(f.sourceId);
    expect(await read({ name: "teaching", arguments: { courseId: f.courseId } })).toMatchObject({ status: "unknown", reason: "no_data", data: [] });
  });
  it("keeps teaching provenance on its compiled source version and rejects an unavailable old version", async () => {
    const f = await learningAttemptFixture(fixture); await publishTeaching(f);
    await fixture.sql`UPDATE opening_sources SET version=2 WHERE id=${f.sourceId}`;
    await fixture.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,availability) VALUES (${f.sourceId},1,${fixture.scope.workspaceId},'available')
      ON CONFLICT(source_id,version) DO UPDATE SET availability='available'`;
    const old = await read({ name: "teaching", arguments: { courseId: f.courseId } });
    expect(old).toMatchObject({ status: "partial", reason: "stale", sourceRefs: [{ sourceId: f.sourceId, sourceVersion: 1 }] });
    await fixture.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,availability) VALUES (${f.sourceId},2,${fixture.scope.workspaceId},'unavailable')`;
    expect((await read({ name: "teaching", arguments: { courseId: f.courseId } })).sourceRefs).toEqual([{ sourceId: f.sourceId, sourceVersion: 1 }]);
    await fixture.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${f.sourceId} AND version=1`;
    expect(await read({ name: "teaching", arguments: { courseId: f.courseId } })).toMatchObject({ status: "unknown", reason: "not_available", data: [], sourceRefs: [] });
  });
  it("does not invent teaching source versions when a published spec is missing", async () => {
    const f = await learningAttemptFixture(fixture);
    expect(await read({ name: "teaching", arguments: { courseId: f.courseId } })).toMatchObject({ status: "unknown", reason: "not_available", data: [], sourceRefs: [] });
  });
});
