import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { assertOpeningTestDatabase } from "@aistudy/config";
import type { ExamSprintState } from "@aistudy/contracts";
import { applyExamSprintCommand, examSprintOverview, composeOpeningBackupDraft, createExamSprintState, validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { createSqlClient } from "../../packages/database/src/migrate";
import { createMemoryOpeningRestoreObjectPut, executeOpeningRestoreApply, readOpeningBackupRecords, readOpeningRestoreNamespaceCounts } from "../../packages/database/src/repositories/opening-backup";
import { insertTestTeachingActivity } from "./opening-fixture";
import { dumpWorkspaceSnapshot, snapshotToPackage } from "../../packages/database/src/repositories/backup-dump";
import { createBackupRestoreRepository } from "../../packages/database/src/repositories/backup-restore";
import { createOpeningKnowledgeRepository } from "../../packages/database/src/repositories/opening-knowledge";
import { createOpeningFirstLearningRepository } from "../../packages/database/src/repositories/opening-first-learning";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { examPackDirectorySections } from "../../packages/database/src/repositories/opening-exam-source-format";
import { validExamLessonExposure } from "../../packages/domain/src/opening/exam-sprint/lesson-exposure-mapping";
import { exportSprintPack, restoreSprintPack } from "../../packages/database/src/repositories/opening-backup-exam-pack";
import { backupRows, sourceBytes, sourceHash } from "./opening-backup-records-fixture";

it.each([
  { mode: "diagnostic", linkage: "current" },
  { mode: "practice", linkage: "forged spec" },
  { mode: "diagnostic", linkage: "mismatched stem" },
  { mode: "diagnostic", linkage: "missing link" },
  { mode: "diagnostic", linkage: "missing binding and link" },
] as const)(
  "restores a course-bound $mode with a $linkage pending attempt", async ({ mode, linkage }) => {
    const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL!, process.env.OPENING_TEST_DB);
    const sql = createSqlClient(url.toString(), { max: 1 });
    const rollback = new Error("rollback restored diagnostic"), discardSeed = new Error("discard source diagnostic");
    const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() }, courseId = randomUUID();
    const pack = EXAM_SPRINT_PACK;
    const createWorkspace = async (tx: TransactionSql) => {
      await tx`INSERT INTO workspaces(id,owner_user_id) VALUES(${scope.workspaceId},${scope.ownerUserId})`;
    };
    try {
      await sql.begin("isolation level repeatable read", async outer => {
        await outer`INSERT INTO users(id,email,display_name,password_hash)
          VALUES(${scope.ownerUserId},${scope.ownerUserId + "@backup.test"},'fixture','test')`;
        const bodies = new Map<string, Uint8Array>();
        let backup: OpeningBackup | undefined;
        let pendingId: string | undefined;
        let questionId: string | undefined;
        await outer.savepoint(async tx => {
          await createWorkspace(tx);
          await tx`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Course','course')`;
          const db = transactionClient(tx);
          const integration = createOpeningExamIntegrationRepository(db, pack, { writePublicSource: async source => {
            bodies.set(`objects/${source.sourceId}/v${source.version}.bin`, source.body);
          } });
          const bound = await integration.bind(scope, { clientKey: randomUUID(), courseId, milestoneId: null,
            expectedPackVersion: pack.version, createKnowledgeNodes: true, skills: [], materials: [] });
          const sprint = createOpeningExamSprintRepository(db, pack);
          const started = await sprint.act(scope, { action: "start", mode, clientKey: randomUUID() });
          pendingId = started.currentAttempt!.id;
          questionId = started.currentAttempt!.questionId;
          const records = await readOpeningBackupRecords(db, scope);
          expect(records.tables.opening_exam_attempt_links).toMatchObject([{ exam_attempt_id: pendingId, publication: "pending_answer" }]);
          expect(records.tables.opening_learning_item_versions).toMatchObject([{ evaluation_spec: null }]);
          const sourceId = bound.binding!.packSourceId, archivePath = `objects/${sourceId}/v0.bin`;
          const body = bodies.get(archivePath)!;
          const sha256 = createHash("sha256").update(body).digest("hex");
          const source = { sourceId, version: 0, bytes: body.byteLength, sha256 };
          const composed = composeOpeningBackupDraft({ records, staging: {
            snapshot: { workspaceId: scope.workspaceId, privacyEpoch: records.privacyEpoch, deletionJournal: records.deletionJournal,
              memoryDeletions: records.memoryDeletions, sources: [source] },
            objects: [{ ...source, actualSha256: sha256, archivePath }],
          } });
          if (!composed.ok) throw new Error(composed.errors.join(", "));
          backup = composed.backup;
          throw discardSeed;
        }).catch(error => { if (error !== discardSeed) throw error; });
        if (!backup || !pendingId || !questionId) throw new Error("Missing diagnostic archive");
        await createWorkspace(outer);
        const question = pack.questions.find(entry => entry.id === questionId)!;
        const wire: OpeningBackup = JSON.parse(JSON.stringify(backup));
        const item = wire.tables.opening_learning_item_versions![0] as Record<string, unknown>;
        const spec = { kind: "exam_choice", specVersion: "exam-choice-v1", packId: pack.id, packVersion: pack.version,
          questionId, familyId: question.familyId };
        if (linkage === "forged spec") {
          const wrongOption = question.options.find(option => option.id !== question.answer)!.id;
          const forged = { ...spec, answer: wrongOption };
          const attempt = wire.tables.opening_learning_attempts![0] as { create_intent: { examSprint: { spec: unknown } } };
          attempt.create_intent.examSprint.spec = forged;
          item.evaluation_spec = forged;
        }
        if (linkage === "mismatched stem") item.stem_snapshot = "Different question";
        if (linkage === "missing link" || linkage === "missing binding and link") wire.tables.opening_exam_attempt_links = [];
        if (linkage === "missing binding and link") {
          wire.tables.opening_exam_bindings = [];
          expect(wire.tables.opening_learning_attempts).toMatchObject([{ create_intent: { examSprint: { examAttemptId: pendingId } } }]);
          expect(wire.tables.opening_teaching_activities).toMatchObject([{ create_intent: { identity: pendingId } }]);
        }
        const db = transactionClient(outer);
        const result = await executeOpeningRestoreApply(db, { confirmLocalRestore: true, backup: wire,
          currentMemoryDeletions: wire.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] },
          objectBodies: bodies, objectPut: createMemoryOpeningRestoreObjectPut() });
        expect(result, result.errors.join(", ")).toMatchObject({ ok: true, objectsApplied: 1 });
        const sprint = createOpeningExamSprintRepository(db, pack);
        const submit = (attemptId: string, answer: string) => sprint.act(scope, { action: "answer", attemptId,
          answer, confidence: 4, clientKey: randomUUID() });
        if (linkage === "current" || linkage === "forged spec") {
          const submitted = await submit(pendingId, question.answer);
          expect(submitted.currentAttempt).toMatchObject({ id: pendingId, correct: true, firstFamilyExposure: false });
          const [observation] = await outer`SELECT o.outcome,o.verdict_source,l.publication,l.first_family_exposure,
              a.create_intent #> '{examSprint,spec}' AS archived_spec
            FROM opening_exam_attempt_links l JOIN opening_learning_observations o ON o.id=l.observation_id
            JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
            WHERE l.exam_attempt_id=${pendingId} AND o.workspace_id=${scope.workspaceId}`;
          expect(observation).toEqual({ outcome: "correct", verdict_source: "deterministic", publication: "published",
            first_family_exposure: false, archived_spec: null });
          const [version] = await outer`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${String(item.id)}`;
          expect(version?.evaluation_spec).toEqual(spec);
        } else {
          const historical = await sprint.read(scope);
          expect(historical).toMatchObject({ activeRun: null, currentAttempt: null,
            attempts: [{ id: pendingId, answer: null, answeredAt: null, correct: null, feedback: null }] });
          await expect(submit(pendingId, question.answer)).rejects.toMatchObject({ code: "CONFLICT" });
          const [activity] = await outer`SELECT status FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}`;
          expect(activity?.status).toBe("completed");
          const fresh = await sprint.act(scope, { action: "start", mode, clientKey: randomUUID() });
          const freshAttempt = fresh.currentAttempt!;
          expect(freshAttempt.id).not.toBe(pendingId);
          const freshQuestion = pack.questions.find(entry => entry.id === freshAttempt.questionId)!;
          expect((await submit(freshAttempt.id, freshQuestion.answer)).currentAttempt).toMatchObject({ correct: true });
          const [version] = await outer`SELECT evaluation_spec FROM opening_learning_item_versions WHERE id=${String(item.id)}`;
          expect(version?.evaluation_spec).toBeNull();
        }
        throw rollback;
      }).catch(error => { if (error !== rollback) throw error; });
    } finally { await sql.end(); }
  }, 30_000,
);

function publishedRequest(activityId: string, sourceId: string, chunk: string) {
  const id = randomUUID();
  const question = { topic: "Algebra", prompt: "Solve the equation", referenceAnswer: "private solution",
    rubric: ["private grading key"], hints: { direction: "d", concept: "c", firstStep: "s" }, evidenceChunkIds: [chunk], estimatedMinutes: 1 };
  return { id, input: { sourceId, questionCount: 3, clientKey: "exam-request" }, sourceVersion: 1,
    sourceTitle: "My paper", privacyEpoch: 0, createdAt: new Date().toISOString(), status: "ready", activityId, modelLabel: null,
    proposal: { title: "Paper", topics: [{ label: "Algebra", evidenceChunkIds: [chunk] }], questions: [question,question,question] } };
}

it("retains generated exam request history without disclosing its unpublished answer material", () => {
  const request = publishedRequest(randomUUID(), randomUUID(), randomUUID());
  const row = { course_id: randomUUID(), state: {}, pack_snapshot: { format: "course-exam-v1", requests: [request] } };
  const projected = exportSprintPack(row);
  expect(projected.pack_snapshot).toMatchObject({ requests: [{ id: request.id, input: request.input, status: "unknown", activityId: null, proposal: null }] });
  expect(JSON.stringify(projected)).not.toContain("private solution");
  expect(restoreSprintPack(projected)).toEqual(projected);
  expect(exportSprintPack({ ...row, state: { referenceAnswer: "private" } }).state).toEqual({});
  expect(() => restoreSprintPack({ ...projected, state: { referenceAnswer: "private" } })).toThrow(/private/i);
  expect(() => restoreSprintPack(row)).toThrow(/private/i);
});

it.each(["mock-a", "mock-b"] as const)("restores %s history without granting catalog feedback", mode => {
  const now = "2026-11-19T12:00:00Z";
  const started = applyExamSprintCommand(createExamSprintState(now), { action: "start", clientKey: "start", mode }, EXAM_SPRINT_PACK, now);
  const attempt = started.attempts[0]!;
  const question = EXAM_SPRINT_PACK.questions.find(row => row.id === attempt.questionId)!;
  const answered = applyExamSprintCommand(started, { action: "answer", clientKey: "answer", attemptId: attempt.id,
    answer: question.options[0]!.id, confidence: 3 }, EXAM_SPRINT_PACK, now);
  for (const state of [started, answered]) {
    const archived = exportSprintPack({ course_id: null, pack_snapshot: EXAM_SPRINT_PACK, state });
    const history = archived.state as ExamSprintState;
    const interrupted = restoreSprintPack(archived).state as ExamSprintState;
    expect(examSprintOverview(interrupted, EXAM_SPRINT_PACK, now)).toMatchObject({ activeRun: null, attempts: [{ feedback: null }] });
    history.runs[0]!.completedAt = now;
    const restored = restoreSprintPack(archived).state as ExamSprintState;
    const overview = examSprintOverview(restored, EXAM_SPRINT_PACK, now);
    expect(overview.attempts[0]).toMatchObject({ feedback: null, correct: null, independent: false });
    expect(overview.summary.onlineAnswered).toBe(0);
    history.runs[0]!.mode = "practice";
    expect(() => restoreSprintPack(archived)).toThrow();
  }
});

// Run the real queries and constraints in a rollback-only test transaction. Inside it,
// each repository transaction has its own savepoint and inherits the outer snapshot.
// Keep the outer transaction writable for the fixture and restore.
function transactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, property, receiver) {
    if (property !== "begin") return Reflect.get(target, property, receiver);
    return (...args: unknown[]) => target.savepoint(args.at(-1) as (nested: TransactionSql) => Promise<unknown>);
  } }) as unknown as Sql;
}

it.skipIf(process.env.OPENING_TEST_DB !== "1" || !process.env.OPENING_TEST_DATABASE_URL)(
  "round-trips the owner-scoped learner assets and refuses excluded graph, note, and exam material", async () => {
    const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL!, process.env.OPENING_TEST_DB);
    const sql = createSqlClient(url.toString(), { max: 1 });
    const rollback = new Error("rollback B3 fixture"), discardSeed = new Error("discard source fixture");
    const w = randomUUID(), u = randomUUID(), course = randomUUID(), doc = randomUUID(), block = randomUUID(), sprint = randomUUID();
    const scope = { workspaceId: w, ownerUserId: u };
    const examDoc = randomUUID(), examBlock = randomUUID(), examSprint = randomUUID();
    const answerBlock = randomUUID(), historicalKey = randomUUID(), legacyExam = randomUUID(), attachment = randomUUID();
    const keyContent = { answer: "private standalone answer", href: "private-key.txt", bytesBase64: "YWJj" };
    const liveContent = { text: "ordinary essay", meta: { sourceId: "external-reference" } };
    const oldBlocks = [{ id: block, type: "text", position: 0, content: { ...liveContent, text: "ordinary essay revision", citationBinding: { refs: ["external-reference"] } } },
      { id: historicalKey, type: "answer_key", position: 1, content: { answer: "private old key" } }];
    try {
      await sql.begin("isolation level repeatable read", async outer => {
        await outer`INSERT INTO users(id,email,display_name,password_hash) VALUES(${u},${u + "@backup.test"},'fixture','test')`;
        await outer`INSERT INTO workspaces(id,owner_user_id) VALUES(${w},${u})`;
        let backup: OpeningBackup | undefined;
        let nativeBackup: ReturnType<typeof snapshotToPackage> | undefined;
        let sourceVersions: Record<string, number> = {};
        await outer.savepoint(async tx => {
          const db = transactionClient(tx), rows = backupRows(db, scope);
          const source = await rows.source(), chunk = await rows.chunk(source);
          const denied = await rows.source(), deniedChunk = await rows.chunk(denied), unread = await rows.source("pending");
          const sourceDigest = createHash("sha256").update(chunk).digest("hex");
          const deniedDigest = createHash("sha256").update(deniedChunk).digest("hex");
          sourceVersions = { [source]: 1 };
          await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
            VALUES(${source},1,${w},${sourceBytes.length},${sourceHash},'available'),
              (${denied},1,${w},${sourceBytes.length},${sourceHash},'available')`;
          const privateDoc = randomUUID(), privateCourse = randomUUID(), node = randomUUID(), privateNode = randomUUID();
          await tx`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${course},${w},'Course','course'),(${privateCourse},${w},'Other','other')`;
          await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle) VALUES
            (${doc},${w},'Essay','confirmed'),(${privateDoc},${w},'excluded note text','confirmed')`;
          for (const [documentId, sourceId] of [[doc,source],[privateDoc,denied]] as const) {
            await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
              VALUES(${documentId},${w},${tx.json([{ sourceId, sourceVersion: 1 }])})`;
          }
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
            VALUES(${block},${w},${doc},'text',0,${tx.json(liveContent)})`;
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
            VALUES(${answerBlock},${w},${doc},'answer_key',1,${tx.json(keyContent)})`;
          await tx`INSERT INTO library_revisions(workspace_id,document_id,revision_number,title,lifecycle,blocks)
            VALUES(${w},${doc},1,'Essay','confirmed',${tx.json(oldBlocks)}),(${w},${privateDoc},1,'excluded revision text','confirmed','[]')`;
          await tx`INSERT INTO library_properties(workspace_id,subject_type,subject_id,key,value_type,value)
            VALUES(${w},'block',${block},'language','string','"en"'),(${w},'document',${privateDoc},'hidden','string','"excluded property"')`;
          await tx`INSERT INTO library_relations(workspace_id,from_type,from_id,to_type,to_id,relation_type)
            VALUES(${w},'document',${doc},'block',${block},'references'),(${w},'document',${doc},'document',${privateDoc},'references')`;
          await tx`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
            VALUES(${w},${course},'source',${source},'core','course'),
              (${w},${course},'source',${unread},'core','course'),
              (${w},${privateCourse},'source',${source},'core','course'),
              (${w},${privateCourse},'source',${denied},'core','course')`;
          const knowledge = createOpeningKnowledgeRepository(db);
          const publishAndConfirm = async (courseId: string, nodeId: string, extractedSourceVersions: Record<string, number>,
            extractedChunkDigests: Record<string, string>) => {
            await knowledge.replace(scope, courseId, { expectedVersion: 0, sourceVersions, extractedSourceVersions,
              extractedChunkDigests, snapshot: { courseId, version: 0, nodes: [{ id: nodeId, courseId, label: "Algebra",
                kind: "concept", evidenceChunkIds: [chunk], status: "needs_check" }], edges: [] } });
            return knowledge.confirmNode(scope, courseId, nodeId, { expectedVersion: 1, sourceVersions });
          };
          const coveredSourceChunkDigests = { [source]: sourceDigest };
          const confirmed = await publishAndConfirm(course, node, sourceVersions, coveredSourceChunkDigests);
          const privateDigests = { ...coveredSourceChunkDigests, [denied]: deniedDigest };
          await publishAndConfirm(privateCourse, privateNode, { ...sourceVersions, [denied]: 1 }, privateDigests);
          await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state)
            VALUES(${sprint},${w},${u},${tx.json(EXAM_SPRINT_PACK as never)},${tx.json(createExamSprintState(new Date().toISOString()) as never)})`;
          await tx`INSERT INTO opening_exam_bindings(sprint_id,course_id,binding) VALUES(${sprint},${course},
            ${tx.json({ courseId: course, packSourceId: source, materials: [], skills: [], milestoneId: null, boundAt: new Date().toISOString() })})`;
          await tx`INSERT INTO opening_exam_source_mappings(sprint_id,source_item_id,skill_ids)
            VALUES(${sprint},'item-a',ARRAY['skill-a']),(${sprint},'item-b',ARRAY['skill-b'])`;
          for (const id of [source,denied]) {
            await tx`INSERT INTO opening_exam_papers(id,sprint_id,workspace_id,owner_user_id,course_id,source_id,source_version,
              teacher,year,label,kind,skills,client_key,intent) VALUES(${randomUUID()},${sprint},${w},${u},${course},${id},1,
              'Teacher',2026,'Paper','sample','[]',${randomUUID()},'{}')`;
            await tx`INSERT INTO opening_exam_reviews(id,sprint_id,workspace_id,owner_user_id,source_item_id,work_source_id,work_source_version,
              reference_source_id,reference_source_version,client_key,intent,status,privacy_epoch)
              VALUES(${randomUUID()},${sprint},${w},${u},'item-a',${id},1,${source},1,${randomUUID()},'{}','failed',0)`;
          }
          const activity = await insertTestTeachingActivity(db, scope, course);
          const request = publishedRequest(activity, source, chunk);
          await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,course_id,pack_snapshot,state)
            VALUES(${examSprint},${w},${u},${course},${tx.json({ format: "course-exam-v1", requests: [request] })},'{}')`;
          const unit = randomUUID();
          await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle) VALUES(${examDoc},${w},'Generated exam','confirmed')`;
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
            VALUES(${examBlock},${w},${examDoc},'answer_key',0,'{"answer":"private live answer","href":"private-exam.txt","bytesBase64":"YWJj"}')`;
          await tx`INSERT INTO library_revisions(workspace_id,document_id,revision_number,title,lifecycle,blocks)
            VALUES(${w},${examDoc},1,'Exam','confirmed','[{"type":"text","content":{"text":"private historical answer"}}]')`;
          await tx`INSERT INTO library_properties(workspace_id,subject_type,subject_id,key,value_type,value)
            VALUES(${w},'block',${examBlock},'answer','string','"private exam property"')`;
          await tx`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number,generation_config)
            VALUES(${unit},${w},${u},'Exam',${examDoc},1,${tx.json({ extras: { kind: "course_exam", requestId: request.id } })})`;
          await tx`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,
            revision_number,version,block_order) VALUES(${randomUUID()},${w},${u},${activity},${unit},${examDoc},1,1,
            ${tx.json([{ blockId: examBlock, position: 0, blockType: "answer_key", role: "answer_key" }])})`;
          await tx`UPDATE opening_teaching_activities SET intent_summary='private generated exam title' WHERE id=${activity}`;
          const unpublished = await insertTestTeachingActivity(db, scope, course);
          await tx`UPDATE opening_teaching_activities SET create_intent='{"kind":"course_exam"}' WHERE id=${unpublished}`;
          const privateSession = randomUUID();
          await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
            VALUES(${privateSession},${w},${u},${course},${activity},'private generated exam title')`;
          const privateTurn = await rows.turn(await rows.conversation());
          await tx`UPDATE opening_turns SET learning_session_id=${privateSession} WHERE id=${privateTurn}`;
          const privateProblem = await rows.problem(privateSession, source);
          const privateObservation = await rows.observation(privateSession, [], [privateTurn], privateProblem);
          const privateHelp = await rows.help(privateSession, privateTurn, privateProblem);
          const evidence = randomUUID(), card = randomUUID();
          await tx`INSERT INTO opening_skill_evidence(id,workspace_id,owner_user_id,course_id,node_id,observation_id,dimension)
            VALUES(${evidence},${w},${u},${course},${node},${privateObservation},'recall')`;
          await tx`INSERT INTO opening_learning_activity_history_revisions(workspace_id,owner_user_id,activity_id,revision)
            VALUES(${w},${u},${activity},1)`;
          await tx`INSERT INTO cards(id,workspace_id,owner_user_id,front,back,origin_observation_root_id)
            VALUES(${card},${w},${u},'private generated exam title','private grading key',${privateObservation})`;
          const privateAttempt = randomUUID();
          await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,
            client_key,create_intent,history_revision) VALUES(${privateAttempt},${w},${u},${privateSession},${course},${activity},'Algebra',${privateAttempt},'{}',0)`;
          const publicActivity = await insertTestTeachingActivity(db, scope, course);
          const session = randomUUID(), observation = randomUUID(), attempt = randomUUID(), link = randomUUID();
          await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
            VALUES(${session},${w},${u},${course},${publicActivity},'Algebra')`;
          await tx`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES(${w},${u},0) ON CONFLICT DO NOTHING`;
          await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,
            client_key,create_intent,history_revision) VALUES(${attempt},${w},${u},${session},${course},${publicActivity},'Algebra',${attempt},'{}',0)`;
          await tx`INSERT INTO opening_learning_observations(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,
            answer,outcome,assistance,client_key,verdict_source,workspace_history_revision)
            VALUES(${observation},${w},${u},${session},${course},${publicActivity},'Algebra','answer','unverified','unknown',${observation},'unknown',0)`;
          await tx`INSERT INTO opening_exam_attempt_links(id,sprint_id,exam_attempt_id,learning_attempt_id,node_id,requirement_key,
            first_family_exposure,observation_id,publication) VALUES(${link},${sprint},'attempt-a',${attempt},${node},'req-a',false,${observation},'published')`;
          await tx`INSERT INTO opening_exam_source_observations(sprint_id,source_record_id,skill_ids,observation_id)
            VALUES(${sprint},'record-a',ARRAY['skill-a'],${observation})`;
          await tx`INSERT INTO opening_exam_help_receipts(id,attempt_link_id,kind,delivered_at,history_revision,workspace_history_revision)
            VALUES(${randomUUID()},${link},'hint',now(),0,0)`;
          const snapshot = async () => {
            const records = await readOpeningBackupRecords(db, scope);
            const sources = records.tables.opening_sources.map(row => ({ sourceId: String(row.id), version: Number(row.version),
              sha256: sourceHash, bytes: sourceBytes.length }));
            const composed = composeOpeningBackupDraft({ records, staging: { snapshot: { workspaceId: w, sources,
              privacyEpoch: records.privacyEpoch, deletionJournal: records.deletionJournal, memoryDeletions: records.memoryDeletions },
              objects: sources.map(s => ({ ...s, actualSha256: sourceHash, archivePath: `objects/${s.sourceId}/v${s.version}.bin` })) } });
            if (!composed.ok) throw new Error(`${composed.code} ${composed.errors.join(", ")}`);
            return composed.backup;
          };
          backup = await snapshot();
          expect(backup.tables.opening_course_knowledge).toContainEqual(expect.objectContaining({
            course_id: course, version: 2, snapshot: { ...confirmed.snapshot, coveredSourceChunkDigests },
          }));
          expect(backup.tables.opening_course_knowledge?.find(row => row.course_id === privateCourse))
            .toMatchObject({ snapshot: { coveredSourceChunkDigests: privateDigests } });
          expect(backup.tables.opening_knowledge_confirmations).toEqual(expect.arrayContaining([
            expect.objectContaining({ course_id: course, node_id: node, graph_version_before: 1, graph_version_after: 2,
              source_versions: sourceVersions, evidence_chunk_ids: [chunk] }),
            expect.objectContaining({ course_id: privateCourse, node_id: privateNode }),
          ]));
          const courseSprint = backup.tables.opening_exam_sprints?.find(row => (row as { id: string }).id === examSprint);
          expect(courseSprint).toMatchObject({ pack_snapshot: { requests: [{ id: request.id, status: "unknown", activityId: null, proposal: null }] } });
          const serialized = JSON.stringify(backup);
          for (const excluded of [activity, unpublished, unit, examDoc, evidence, card, privateSession, privateProblem, privateObservation, privateHelp,
            privateAttempt, privateTurn, "private generated exam title"]) expect(serialized).not.toContain(excluded);
          expect(backup.tables.opening_learning_attempts).toMatchObject([{ id: attempt, activity_id: publicActivity }]);
          // Later edits may replace the unit metadata. The pinned publication still owns the document.
          await tx`UPDATE opening_teaching_units SET generation_config='{}' WHERE id=${unit}`;
          const native = await dumpWorkspaceSnapshot(db, w, u);
          for (const artifact of [backup, native]) {
            const wire = JSON.stringify(artifact);
            expect(wire).toContain(doc);
            expect(wire).not.toContain(examDoc);
            expect(wire).not.toMatch(/private (solution|grading key|live answer|historical answer|exam property|standalone answer|old key)|private-(exam|key)\.txt/);
            expect(wire).toContain("ordinary essay revision");
          }
          expect(native.files).toHaveLength(0);
          // Native v1 stores attachments as block content plus a file manifest.
          const examContent = { href: "private-paper.txt", bytesBase64: "YWJj" };
          const legacyExamBlocks = [{ id: randomUUID(), type: "answer_key", position: 0,
            content: { generated: true, hidden: true, answer: "private generated answer\n\n评分要点：\n- key" } }];
          const safeDoc = { id: legacyExam, workspaceId: w, title: "Legacy generated paper", lifecycle: "confirmed", openingProvenance: null };
          const paper = { id: attachment, workspaceId: w, documentId: legacyExam, type: "file", position: 0, content: examContent };
          for (const name of ["opening_exam_bindings","opening_exam_attempt_links","opening_exam_source_observations",
            "opening_exam_help_receipts"]) expect(backup.tables[name], name).toHaveLength(1);
          const historyDoc = randomUUID(), historyBlock = randomUUID();
          const historyUnit = randomUUID(), historyActivity = randomUUID(), historySpec = randomUUID();
          const historySession = randomUUID(), historyAttempt = randomUUID();
          await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle,current_revision_number)
            VALUES(${historyDoc},${w},'Historical citation','published',2)`;
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
            VALUES(${historyBlock},${w},${historyDoc},'text',0,${tx.json(liveContent)})`;
          await tx`INSERT INTO library_revisions(workspace_id,document_id,revision_number,title,lifecycle,blocks)
            VALUES(${w},${historyDoc},1,'Historical citation','confirmed',${tx.json([{ id: historyBlock, type: "text", position: 0,
              content: { text: "excluded historical citation", citationBinding: { blockId: historyBlock, role: "teach",
                status: "bound", factualSupport: "unverified", refs: [{ sourceId: denied, sourceVersion: 1, chunkId: deniedChunk, page: null }] } },
            }])}),
            (${w},${historyDoc},2,'Historical citation','published',${tx.json([{ id: historyBlock, type: "text", position: 0,
              content: liveContent }])})`;
          await tx`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,intent_summary,source_ids,client_key,create_intent)
            VALUES(${historyActivity},${w},${u},${course},'active','ready','topic','Historical doc lesson',ARRAY[${source}]::uuid[],${"hist-" + historyActivity},'{"source":"seed"}'::jsonb)`;
          await tx`INSERT INTO opening_teaching_units(id,workspace_id,owner_user_id,title,document_id,current_revision_number,verification_status)
            VALUES(${historyUnit},${w},${u},'Historical doc lesson',${historyDoc},2,'verified')`;
          await tx`INSERT INTO opening_teaching_activity_specs(id,workspace_id,owner_user_id,activity_id,teaching_unit_id,document_id,revision_number,block_order,source_refs,verification_status,version)
            VALUES(${historySpec},${w},${u},${historyActivity},${historyUnit},${historyDoc},2,${tx.json([{ blockId: historyBlock, blockType: "text", role: "teach" }])},${tx.json([{ sourceId: source, sourceVersion: 1 }])},'verified',1)`;
          await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
            VALUES(${historySession},${w},${u},${course},${historyActivity},'hist-skill',ARRAY[${source}]::uuid[])`;
          await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,source_ids,source_versions,client_key,create_intent,history_revision,context_anchor)
            VALUES(${historyAttempt},${w},${u},${historySession},${course},${historyActivity},'hist-skill',ARRAY[${source}]::uuid[],${tx.json({ [source]: 1 })},${"att-" + historyAttempt},'{}'::jsonb,0,${tx.json({ purpose: "learning_help", courseId: course, activityId: historyActivity, contentVersion: 1, blockId: historyBlock })})`;
          const historyConv = randomUUID(), historyTurn = randomUUID(), derivedActivity = randomUUID();
          await tx`INSERT INTO opening_conversations(id,workspace_id,owner_user_id,course_id,title)
            VALUES(${historyConv},${w},${u},${course},'Historical lesson chat')`;
          await tx`INSERT INTO opening_turns(id,workspace_id,conversation_id,learning_session_id,role,text,mode,status,source_ids,source_versions,citations)
            VALUES(${historyTurn},${w},${historyConv},${historySession},'user','Compile follow-up','hint','complete',ARRAY[${source}]::uuid[],${tx.json({ [source]: 1 })},'[]'::jsonb)`;
          await tx`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,generate_status,intent_kind,intent_summary,source_ids,client_key,create_intent)
            VALUES(${derivedActivity},${w},${u},${course},'active','ready','topic','Derived lesson',ARRAY[${source}]::uuid[],${"der-" + derivedActivity},${tx.json({ sourceTurnId: historyTurn.toUpperCase() })})`;
          const beforeExclusion = await snapshot();
          expect(beforeExclusion.tables.library_revisions).toContainEqual(expect.objectContaining({ document_id: historyDoc }));
          expect(beforeExclusion.tables.opening_teaching_activities).toContainEqual(expect.objectContaining({ id: historyActivity }));
          expect(beforeExclusion.tables.opening_teaching_activities).toContainEqual(expect.objectContaining({ id: derivedActivity }));
          expect(beforeExclusion.tables.opening_learning_sessions).toContainEqual(expect.objectContaining({ id: historySession }));
          expect(beforeExclusion.tables.opening_learning_attempts).toContainEqual(expect.objectContaining({ id: historyAttempt }));
          expect(beforeExclusion.tables.opening_turns).toContainEqual(expect.objectContaining({ id: historyTurn }));
          const nativeBeforeExclusion = await dumpWorkspaceSnapshot(db, w, u);
          expect(nativeBeforeExclusion.revisions).toContainEqual(expect.objectContaining({ documentId: historyDoc }));
          nativeBackup = snapshotToPackage({ ...native, courses: [], memberships: [], documents: [
            ...native.documents.filter(row => row.id === doc).map(row => ({ ...row, openingProvenance: null })), safeDoc,
            ...nativeBeforeExclusion.documents.filter(row => row.id === historyDoc)],
            blocks: [...native.blocks, paper, { id: answerBlock, workspaceId: w, documentId: doc, type: "answer_key", position: 1, content: keyContent },
              ...nativeBeforeExclusion.blocks.filter(row => row.documentId === historyDoc)],
            revisions: [...native.revisions.filter(row => row.documentId === doc).map(row => ({ ...row, blocks: oldBlocks })),
              { id: randomUUID(), workspaceId: w, documentId: legacyExam, revisionNumber: 1, title: safeDoc.title,
                lifecycle: "confirmed", blocks: legacyExamBlocks },
              ...nativeBeforeExclusion.revisions.filter(row => row.documentId === historyDoc)],
            relations: [], files: [{ path: examContent.href, mediaType: "text/plain", bytes: sourceBytes }] });
          await rows.exclude(denied);
          const filtered = await snapshot();
          const filteredNative = await dumpWorkspaceSnapshot(db, w, u);
          for (const artifact of [filtered, filteredNative]) {
            expect(JSON.stringify(artifact)).not.toContain(historyDoc);
            expect(JSON.stringify(artifact)).not.toContain("excluded historical citation");
          }
          for (const removedId of [historyActivity, historySession, historyAttempt, historyTurn, derivedActivity]) {
            expect(JSON.stringify(filtered)).not.toContain(removedId);
          }
          expect(validateOpeningRestore(beforeExclusion, filtered.deletionJournal, filtered.memoryDeletions).errors)
            .toContain("table library_revisions references a deleted source");
          for (const table of ["library_documents","library_revisions","library_properties","library_relations","opening_note_provenance",
            "opening_course_knowledge","opening_knowledge_confirmations","opening_exam_papers","opening_exam_reviews"] as const) {
            expect(filtered.tables[table], table).toHaveLength(1);
          }
          expect(filtered.tables.opening_course_knowledge?.[0]).toMatchObject({
            course_id: course, snapshot: { ...confirmed.snapshot, coveredSourceChunkDigests },
          });
          expect(filtered.tables.opening_knowledge_confirmations?.[0]).toMatchObject({ node_id: node });
          expect(JSON.stringify(filtered)).not.toContain(deniedDigest);
          expect(JSON.stringify(filtered)).not.toMatch(/excluded note text|excluded property|node_definitions|excluded revision text/);
          expect(filtered.tables.opening_exam_sprints?.find(row => (row as { id: string }).id === sprint)).toMatchObject({ pack_snapshot: { id: EXAM_SPRINT_PACK.id, version: EXAM_SPRINT_PACK.version } });
          throw discardSeed;
        }).catch(error => { if (error !== discardSeed) throw error; });
        if (!backup || !nativeBackup) throw new Error("missing snapshot");
        const legacyNative = nativeBackup;
        await outer.savepoint(async tx => {
          const repository = createBackupRestoreRepository(transactionClient(tx));
          const result = await repository.restoreWorkspace({ ...scope, packed: legacyNative, conflictPolicy: "reject" });
          expect(result.applied).toMatchObject({ documents: 1, blocks: 1, revisions: 1, files: 0 });
          expect(await tx`SELECT id FROM library_documents WHERE workspace_id=${w}`).toEqual([{ id: doc }]);
          expect(await tx`SELECT blocks FROM library_revisions WHERE document_id=${doc}`)
            .toEqual([{ blocks: [oldBlocks[0]] }]);
          throw discardSeed;
        }).catch(error => { if (error !== discardSeed) throw error; });
        const wire: OpeningBackup = JSON.parse(JSON.stringify(backup));
        expect(validateOpeningRestore(wire, [], wire.memoryDeletions)).toMatchObject({ allowed: true, errors: [] });
        const publication = structuredClone(wire);
        publication.tables.opening_teaching_units!.push({ id: randomUUID(), workspace_id: w, owner_user_id: u,
          document_id: doc, generation_config: { extras: { kind: "course_exam" } } });
        expect(validateOpeningRestore(publication, [], wire.memoryDeletions).errors).toContain(
          "Private generated exam publications cannot be restored from a learner backup");
        const forged = structuredClone(wire);
        (forged.tables.opening_exam_help_receipts![0] as Record<string, unknown>).attempt_link_id = randomUUID();
        expect(validateOpeningRestore(forged, [], forged.memoryDeletions).allowed).toBe(false);
        (forged.tables.opening_course_knowledge![0] as Record<string, unknown>).node_definitions = { private: "untrusted" };
        expect(validateOpeningRestore(forged, [], forged.memoryDeletions).errors).toContain(
          "opening_course_knowledge has an invalid identity, owner or asset reference");
        const objectPut = createMemoryOpeningRestoreObjectPut();
        const legacy = structuredClone(wire);
        legacy.tables.library_documents!.push({ id: legacyExam, workspace_id: w, title: "Legacy generated paper", lifecycle: "confirmed" });
        for (const row of legacyNative.records.blocks.filter(row => row.id === answerBlock || row.id === attachment)) {
          const { workspaceId, documentId, ...fields } = row;
          legacy.tables.library_blocks!.push({ ...fields, workspace_id: workspaceId, document_id: documentId });
        }
        (legacy.tables.library_revisions!.find(row => row.document_id === doc)!).blocks = oldBlocks;
        legacy.tables.library_revisions!.push({ id: randomUUID(), workspace_id: w, document_id: legacyExam,
          revision_number: 1, title: "Legacy generated paper", lifecycle: "confirmed",
          blocks: legacyNative.records.revisions.find(row => row.documentId === legacyExam)!.blocks });
        const result = await executeOpeningRestoreApply(transactionClient(outer), { confirmLocalRestore: true, backup: legacy,
          objectBodies: new Map(wire.objects.map(object => [object.archivePath, sourceBytes])), objectPut,
          currentMemoryDeletions: wire.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
        expect(result, result.errors.join(", ")).toMatchObject({ ok: true, objectApplyDeferred: false, objectsApplied: 2 });
        const counts = await readOpeningRestoreNamespaceCounts(transactionClient(outer), w);
        for (const [name, records] of Object.entries(wire.tables)) expect(counts[name as keyof typeof counts], name).toBe(records.length);
        const knowledge = createOpeningKnowledgeRepository(transactionClient(outer));
        const restoredGraph = await knowledge.getForRebuild(scope, course);
        expect(Object.keys(restoredGraph!.nodeDefinitions)).toHaveLength(1);
        const [stored] = await outer`SELECT snapshot FROM opening_course_knowledge WHERE course_id=${course}`;
        expect(stored?.snapshot).toEqual(wire.tables.opening_course_knowledge!.find(row => row.course_id === course)!.snapshot);
        expect(await knowledge.readSyncStatus(scope, course)).toMatchObject({ status: "up_to_date",
          coveredSourceVersions: sourceVersions });
        const receipts = await outer`SELECT * FROM opening_knowledge_confirmations WHERE workspace_id=${w} ORDER BY id`;
        expect(JSON.parse(JSON.stringify(receipts))).toEqual(wire.tables.opening_knowledge_confirmations);
        const rebuilt = await knowledge.replace(scope, course, { expectedVersion: restoredGraph!.version, sourceVersions,
          expectedReferencedNodeIds: await knowledge.listReferencedNodeIds(scope, course), snapshot: { ...restoredGraph!.snapshot,
            nodes: restoredGraph!.snapshot.nodes.map(node => ({ ...node, status: "needs_check" })) } });
        expect(rebuilt.snapshot.nodes[0]?.status).toBe("supported");
        expect(await outer`SELECT * FROM opening_knowledge_confirmations WHERE workspace_id=${w} ORDER BY id`).toEqual(receipts);
        expect(await outer`SELECT blocks FROM library_revisions WHERE document_id=${doc}`).toEqual([{ blocks: [oldBlocks[0]] }]);
        expect(await outer`SELECT content FROM library_blocks WHERE id=${block}`).toEqual([{ content: liveContent }]);
        const [property] = await outer`SELECT value FROM library_properties WHERE subject_id=${block}`;
        expect(property?.value).toBe("en");
        const [restored] = await outer`SELECT pack_snapshot FROM opening_exam_sprints WHERE id=${sprint}`;
        expect(restored?.pack_snapshot).toEqual(EXAM_SPRINT_PACK);
        const [generated] = await outer`SELECT pack_snapshot FROM opening_exam_sprints WHERE id=${examSprint}`;
        expect(generated?.pack_snapshot.requests[0]).toMatchObject({ status: "unknown", proposal: null, activityId: null });
        expect(await outer`SELECT id FROM library_documents WHERE id=${examDoc}`).toHaveLength(0);
        throw rollback;
      }).catch(error => { if (error !== rollback) throw error; });
    } finally { await sql.end(); }
  }, 60_000);

it("serializes first-learning initialization and restore on an empty workspace", async () => {
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL!, process.env.OPENING_TEST_DB);
  const application = `restore-lock-test-${randomUUID()}`;
  const sql = createSqlClient(url.toString(), { max: 2 });
  url.searchParams.set("application_name", application);
  url.searchParams.set("statement_timeout", "5000");
  const restoring = createSqlClient(url.toString(), { max: 1 });
  const workspaceId = randomUUID(), ownerUserId = randomUUID(), clientKey = randomUUID();
  const scope = { workspaceId, ownerUserId }, startDate = "2026-11-19";
  let restore: ReturnType<typeof executeOpeningRestoreApply> | undefined;
  try {
    await sql`INSERT INTO users(id,email,display_name,password_hash)
      VALUES(${ownerUserId},${ownerUserId + "@backup.test"},'fixture','test')`;
    await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${workspaceId},${ownerUserId})`;
    const records = await readOpeningBackupRecords(sql, scope);
    const composed = composeOpeningBackupDraft({ records, staging: {
      snapshot: { workspaceId, privacyEpoch: 0, deletionJournal: [], memoryDeletions: records.memoryDeletions, sources: [] }, objects: [],
    } });
    if (!composed.ok) throw new Error(composed.errors.join(", "));
    composed.backup.tables.opening_workspace_history_revisions = [{ workspace_id: workspaceId, owner_user_id: ownerUserId, revision: 0 }];

    const initialized = await sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      restore = executeOpeningRestoreApply(restoring, { confirmLocalRestore: true, backup: composed.backup,
        currentMemoryDeletions: records.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
      // Hold the real history insert until the other connection is waiting for
      // this transaction. Before the fix it held the workspace lock here.
      let blocked: string | undefined;
      for (let probe = 0; probe < 100 && blocked === undefined; probe++) {
        const [row] = await sql`SELECT query FROM pg_stat_activity WHERE application_name=${application}
          AND cardinality(pg_blocking_pids(pid)) > 0`;
        if (row) blocked = String(row.query);
        else await setTimeout(20);
      }
      expect(blocked).toMatch(/INSERT INTO opening_workspace_history_revisions[\s\S]*ON CONFLICT DO NOTHING/);
      return createOpeningFirstLearningRepository(transactionClient(tx)).initialize(scope, {
        intent: { clientKey, topic: "Arithmetic", goal: "", targetDate: null, minutes: 20,
          startTime: null, timeZone: "UTC", sourceIds: [] },
        startDate, planTimeZone: "UTC", days: [],
      });
    });
    expect(initialized.courseId).toBe(clientKey);
    expect(await restore).toMatchObject({ ok: false, code: "TARGET_NOT_EMPTY", mutated: false });
    expect(await sql`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`)
      .toEqual([{ revision: "1" }]);
  } finally {
    await restore;
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id=${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id=${workspaceId}`;
    await sql`DELETE FROM users WHERE id=${ownerUserId}`;
    await Promise.all([sql.end(), restoring.end()]);
  }
}, 15_000);

it("keeps unanswered mock conversion receipts while removing the catalog solution from backup and restore", async () => {
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL!, process.env.OPENING_TEST_DB);
  const sql = createSqlClient(url.toString(), { max: 1 });
  const rollback = new Error("rollback conversion fixture"), discardSeed = new Error("discard conversion source");
  const w = randomUUID(), u = randomUUID(), course = randomUUID(), sprint = randomUUID(), source = randomUUID();
  const scope = { workspaceId: w, ownerUserId: u }, pack = EXAM_SPRINT_PACK;
  const sections = examPackDirectorySections(pack);
  const body = Buffer.from(sections.map(section => section.text).join("\n\n"), "utf8");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const archivedSource = { sourceId: source, version: 0, sha256, bytes: body.length };
  const archivePath = `objects/${source}/v0.bin`;
  try {
    await sql.begin("isolation level repeatable read", async outer => {
      await outer`INSERT INTO users(id,email,display_name,password_hash) VALUES(${u},${u + "@backup.test"},'fixture','test')`;
      await outer`INSERT INTO workspaces(id,owner_user_id) VALUES(${w},${u})`;
      let backup: OpeningBackup | undefined;
      let legacyContent: string | undefined;
      await outer.savepoint(async tx => {
        const db = transactionClient(tx), repo = createOpeningExamSprintRepository(db, pack);
        await tx`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${course},${w},'Course','course')`;
        await tx`INSERT INTO opening_sources(id,workspace_id,name,mime,version,bytes,sha256,upload_state,parse_state)
          VALUES(${source},${w},'Exam directory','text/plain',0,${body.length},${sha256},'uploaded','ready')`;
        await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
          VALUES(${source},0,${w},${body.length},${sha256},'available')`;
        for (const [index, section] of sections.entries()) {
          await tx`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${source},0,${index + 1},${section.text})`;
        }
        await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state)
          VALUES(${sprint},${w},${u},${tx.json(pack as never)},${tx.json(createExamSprintState(new Date().toISOString()) as never)})`;
        await tx`INSERT INTO opening_exam_bindings(sprint_id,course_id,binding) VALUES(${sprint},${course},
          ${tx.json({ courseId: course, packSourceId: source, materials: [], milestoneId: null, boundAt: new Date().toISOString(),
            skills: [...new Set(pack.questions.map(question => question.skillId))]
              .map(skillId => ({ skillId, nodeId: randomUUID(), requirementKey: skillId })) })})`;
        const mock = await repo.act(scope, { action: "start", mode: "mock-a", clientKey: randomUUID() });
        const attempt = mock.currentAttempt!;
        const question = pack.questions.find(entry => entry.id === attempt.questionId)!;
        const lesson = pack.lessons.find(entry => entry.id === question.lessonId)!;
        const mapping = validExamLessonExposure(lesson)!;
        const converted = await repo.act(scope, { action: "switch_to_teaching", clientKey: randomUUID(),
          expectedAttemptId: attempt.id, expectedRunId: mock.activeRun!.id, lessonId: lesson.id, packVersion: pack.version,
          contentFingerprint: mapping.contentFingerprint, mappingVersion: mapping.mappingVersion, confirmedEndScoredMock: true });
        expect(converted.activeRun).toBeNull();
        expect(converted.attempts.find(entry => entry.id === attempt.id)).toMatchObject({ answer: null, independent: false });
        const [receipt] = await tx`SELECT r.* FROM opening_exam_help_receipts r JOIN opening_exam_attempt_links l
          ON l.id=r.attempt_link_id WHERE l.sprint_id=${sprint}`;
        legacyContent = `${question.answer}\n${question.explanation}`;
        expect(receipt).toMatchObject({ kind: "solution", content_snapshot: legacyContent });
        const records = await readOpeningBackupRecords(db, scope);
        expect(records.tables.opening_exam_help_receipts).toMatchObject([{ ...receipt, content_snapshot: null }]);
        expect(JSON.stringify(records)).not.toContain(JSON.stringify(question.explanation).slice(1, -1));
        const composed = composeOpeningBackupDraft({ records, staging: {
          snapshot: { workspaceId: w, privacyEpoch: records.privacyEpoch, deletionJournal: records.deletionJournal,
            memoryDeletions: records.memoryDeletions, sources: [archivedSource] },
          objects: [{ ...archivedSource, actualSha256: sha256, archivePath }],
        } });
        if (!composed.ok) throw new Error(composed.errors.join(", "));
        backup = composed.backup;
        throw discardSeed;
      }).catch(error => { if (error !== discardSeed) throw error; });
      if (!backup || !legacyContent) throw new Error("missing conversion archive");
      const wire: OpeningBackup = JSON.parse(JSON.stringify(backup));
      const archivedReceipt = wire.tables.opening_exam_help_receipts![0] as Record<string, unknown>;
      archivedReceipt.content_snapshot = legacyContent;
      const result = await executeOpeningRestoreApply(transactionClient(outer), { confirmLocalRestore: true,
        backup: wire, currentMemoryDeletions: wire.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
      expect(result, result.errors.join(", ")).toMatchObject({ ok: true });
      const restored = await createOpeningExamSprintRepository(transactionClient(outer), pack).read(scope);
      expect(restored).toMatchObject({ activeRun: null, currentAttempt: null,
        attempts: [{ answer: null, answeredAt: null, correct: null, feedback: null }] });
      const [receipt] = await outer`SELECT * FROM opening_exam_help_receipts WHERE id=${String(archivedReceipt.id)}`;
      expect(receipt).toMatchObject({ id: archivedReceipt.id, attempt_link_id: archivedReceipt.attempt_link_id, kind: "solution",
        delivered_at: new Date(String(archivedReceipt.delivered_at)), history_revision: archivedReceipt.history_revision,
        workspace_history_revision: archivedReceipt.workspace_history_revision, content_snapshot: null });
      throw rollback;
    }).catch(error => { if (error !== rollback) throw error; });
  } finally { await sql.end(); }
}, 30_000);
