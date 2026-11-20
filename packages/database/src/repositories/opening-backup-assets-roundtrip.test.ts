import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { composeOpeningBackupDraft, createExamSprintState, validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { createSqlClient } from "../migrate";
import { createMemoryOpeningRestoreObjectPut, executeOpeningRestoreApply, readOpeningBackupRecords, readOpeningRestoreNamespaceCounts } from "./opening-backup";
import { insertTestTeachingActivity } from "../../../../tests/integration/opening-fixture";
import { dumpWorkspaceSnapshot } from "./backup-dump";
import { exportSprintPack, restoreSprintPack } from "./opening-backup-exam-pack";
import { backupRows, sourceBytes, sourceHash } from "../../../../tests/integration/opening-backup-records-fixture";

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

// Run the real queries and constraints in a rollback-only test transaction. Inside it,
// each repository transaction has its own savepoint. No persistent fixture or object writes.
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
    try {
      await expect(sql.begin(async outer => {
        await outer`INSERT INTO users(id,email,display_name,password_hash) VALUES(${u},${u + "@backup.test"},'fixture','test')`;
        await outer`INSERT INTO workspaces(id,owner_user_id) VALUES(${w},${u})`;
        let backup: OpeningBackup | undefined;
        await expect(outer.savepoint(async tx => {
          const db = transactionClient(tx), rows = backupRows(db, scope);
          const source = await rows.source(), chunk = await rows.chunk(source), denied = await rows.source();
          const privateDoc = randomUUID(), privateCourse = randomUUID(), node = randomUUID();
          await tx`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${course},${w},'Course','course'),(${privateCourse},${w},'Other','other')`;
          await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle) VALUES
            (${doc},${w},'Essay','confirmed'),(${privateDoc},${w},'excluded note text','confirmed')`;
          for (const [documentId, sourceId] of [[doc,source],[privateDoc,denied]] as const) {
            await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
              VALUES(${documentId},${w},${tx.json([{ sourceId, sourceVersion: 1 }])})`;
          }
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position) VALUES(${block},${w},${doc},'text',0)`;
          await tx`INSERT INTO library_revisions(workspace_id,document_id,revision_number,title,lifecycle,blocks)
            VALUES(${w},${doc},1,'Essay','confirmed','[]'),(${w},${privateDoc},1,'excluded revision text','confirmed','[]')`;
          await tx`INSERT INTO library_properties(workspace_id,subject_type,subject_id,key,value_type,value)
            VALUES(${w},'block',${block},'language','string','"en"'),(${w},'document',${privateDoc},'hidden','string','"excluded property"')`;
          await tx`INSERT INTO library_relations(workspace_id,from_type,from_id,to_type,to_id,relation_type)
            VALUES(${w},'document',${doc},'block',${block},'references'),(${w},'document',${doc},'document',${privateDoc},'references')`;
          for (const [courseId, sourceId] of [[course,source],[privateCourse,denied]] as const) {
            const snapshot = { courseId, version: 1, nodes: [{ id: node, courseId, label: "Algebra", kind: "concept",
              evidenceChunkIds: [chunk], status: "supported" }], edges: [] };
            await tx`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions,node_definitions)
              VALUES(${w},${u},${courseId},1,${tx.json(snapshot)},${tx.json({ [sourceId]: 1 })},'{"private":"server-only text"}')`;
            await tx`INSERT INTO opening_knowledge_confirmations(id,workspace_id,owner_user_id,course_id,node_id,node_label,node_kind,
              graph_version_before,graph_version_after,source_versions,evidence_chunk_ids)
              VALUES(${randomUUID()},${w},${u},${courseId},${node},'Algebra','concept',0,1,${tx.json({ [sourceId]: 1 })},${tx.json([chunk])})`;
          }
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
          const session = randomUUID(), observation = randomUUID(), attempt = randomUUID(), link = randomUUID();
          await tx`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label)
            VALUES(${session},${w},${u},${course},${activity},'Algebra')`;
          await tx`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES(${w},${u},0)`;
          await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,
            client_key,create_intent,history_revision) VALUES(${attempt},${w},${u},${session},${course},${activity},'Algebra',${attempt},'{}',0)`;
          await tx`INSERT INTO opening_learning_observations(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,
            answer,outcome,assistance,client_key,verdict_source,workspace_history_revision)
            VALUES(${observation},${w},${u},${session},${course},${activity},'Algebra','answer','unverified','unknown',${observation},'unknown',0)`;
          await tx`INSERT INTO opening_exam_attempt_links(id,sprint_id,exam_attempt_id,learning_attempt_id,node_id,requirement_key,
            first_family_exposure,observation_id,publication) VALUES(${link},${sprint},'attempt-a',${attempt},${node},'req-a',false,${observation},'published')`;
          await tx`INSERT INTO opening_exam_source_observations(sprint_id,source_record_id,skill_ids,observation_id)
            VALUES(${sprint},'record-a',ARRAY['skill-a'],${observation})`;
          await tx`INSERT INTO opening_exam_help_receipts(id,attempt_link_id,kind,delivered_at,history_revision,workspace_history_revision)
            VALUES(${randomUUID()},${link},'hint',now(),0,0)`;
          await tx`UPDATE opening_learning_attempts SET context_anchor=${tx.json({ purpose: "exam_help", activityId: activity,
            blockId: examBlock, contentVersion: 1 })} WHERE id=${attempt}`;
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
          const courseSprint = backup.tables.opening_exam_sprints?.find(row => (row as { id: string }).id === examSprint);
          expect(courseSprint).toMatchObject({ pack_snapshot: { requests: [{ id: request.id, status: "unknown", activityId: null, proposal: null }] } });
          expect(backup.tables.opening_learning_attempts?.[0]).toMatchObject({ context_anchor: {
            purpose: "exam_help", activityId: activity, blockId: null, contentVersion: null } });
          // Later edits may replace the unit metadata. The pinned publication still owns the document.
          await tx`UPDATE opening_teaching_units SET generation_config='{}' WHERE id=${unit}`;
          const native = await dumpWorkspaceSnapshot(db, w, u);
          for (const artifact of [backup, native]) {
            const wire = JSON.stringify(artifact);
            expect(wire).toContain(doc);
            expect(wire).not.toContain(examDoc);
            expect(wire).not.toMatch(/private (solution|grading key|live answer|historical answer|exam property)|private-exam\.txt/);
          }
          expect(native.files).toHaveLength(0);
          for (const name of ["opening_exam_bindings","opening_exam_attempt_links","opening_exam_source_observations",
            "opening_exam_help_receipts"]) expect(backup.tables[name], name).toHaveLength(1);
          await rows.exclude(denied);
          const filtered = await snapshot();
          for (const table of ["library_documents","library_revisions","library_properties","library_relations","opening_note_provenance",
            "opening_course_knowledge","opening_knowledge_confirmations","opening_exam_papers","opening_exam_reviews"] as const) {
            expect(filtered.tables[table], table).toHaveLength(1);
          }
          expect(JSON.stringify(filtered)).not.toMatch(/server-only text|excluded note text|excluded property|node_definitions|excluded revision text/);
          expect(filtered.tables.opening_exam_sprints?.find(row => (row as { id: string }).id === sprint)).toMatchObject({ pack_snapshot: { id: EXAM_SPRINT_PACK.id, version: EXAM_SPRINT_PACK.version } });
          throw discardSeed;
        })).rejects.toBe(discardSeed);
        if (!backup) throw new Error("missing snapshot");
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
        const result = await executeOpeningRestoreApply(transactionClient(outer), { confirmLocalRestore: true, backup: wire,
          objectBodies: new Map(wire.objects.map(object => [object.archivePath, sourceBytes])), objectPut,
          currentMemoryDeletions: wire.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] } });
        expect(result, result.errors.join(", ")).toMatchObject({ ok: true, objectApplyDeferred: false, objectsApplied: 2 });
        const counts = await readOpeningRestoreNamespaceCounts(transactionClient(outer), w);
        for (const [name, records] of Object.entries(wire.tables)) expect(counts[name as keyof typeof counts], name).toBe(records.length);
        const [graph] = await outer`SELECT node_definitions FROM opening_course_knowledge WHERE course_id=${course}`;
        expect(graph?.node_definitions).toEqual({});
        const [property] = await outer`SELECT value FROM library_properties WHERE subject_id=${block}`;
        expect(property?.value).toBe("en");
        const [restored] = await outer`SELECT pack_snapshot FROM opening_exam_sprints WHERE id=${sprint}`;
        expect(restored?.pack_snapshot).toEqual(EXAM_SPRINT_PACK);
        const [generated] = await outer`SELECT pack_snapshot FROM opening_exam_sprints WHERE id=${examSprint}`;
        expect(generated?.pack_snapshot.requests[0]).toMatchObject({ status: "unknown", proposal: null, activityId: null });
        expect(await outer`SELECT id FROM library_documents WHERE id=${examDoc}`).toHaveLength(0);
        throw rollback;
      })).rejects.toBe(rollback);
    } finally { await sql.end(); }
  }, 60_000);
