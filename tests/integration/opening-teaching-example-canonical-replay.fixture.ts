import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { TeachingBlockRef, TeachingCommandRequest } from "@aistudy/contracts";
import {
  createOpeningLearningRepository, createOpeningTeachingActivitiesRepository,
  createOpeningTeachingContentRepository, readOpeningLearningEvidenceContext,
} from "@aistudy/database";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
import { backupRows } from "./opening-backup-records-fixture";
import type { OpeningFixture } from "./opening-fixture";

/** Synthetic admitted material only. All command/library/exposure/eligibility SQL is real. */
export async function canonicalExampleFixture(f: OpeningFixture, withQuestion = true, blockCount?: number) {
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source(), chunkId = await rows.chunk(sourceId), courseId = randomUUID();
  await f.sql`UPDATE opening_source_chunks SET image_object_key=NULL WHERE id=${chunkId}`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Synthetic calculus command lifecycle',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,purpose)
    VALUES(${f.scope.workspaceId},${courseId},'source',${sourceId},'core','course',NULL)`;
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "多项式求导", courseId, sourceIds: [sourceId], createIntent: {},
  });
  const exampleId = randomUUID(), questionId = randomUUID(), answerId = randomUUID();
  const blocks = [{ id: exampleId, type: "example", content: { text: "求函数 f(x)=x^2 的导数。" } }];
  const order: TeachingBlockRef[] = [{ blockId: exampleId, position: 0, role: "example", blockType: "example" }];
  if (withQuestion) {
    blocks.push({ id: questionId, type: "prompt", content: { text: "求函数 f(x)=x^3 的导数。" } });
    blocks.push({ id: answerId, type: "answer_key", content: { text: "3x^2" } });
    order.push({ blockId: questionId, position: 1, role: "prompt", blockType: "prompt" },
      { blockId: answerId, position: 2, role: "answer_key", blockType: "answer_key" });
  }
  while (blocks.length < (blockCount ?? blocks.length)) {
    const id = randomUUID();
    order.push({ blockId: id, position: blocks.length, role: "teach", blockType: "paragraph" });
    blocks.push({ id, type: "paragraph", content: { text: "Synthetic context" } });
  }
  const content = createOpeningTeachingContentRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "Synthetic calculus", blocks });
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id,
    expectedVersion: 0, expectedRevisionNumber: 1, revisionNumber: 1, blockOrder: order,
    sourceRefs: [{ sourceId, chunkId, version: 1, page: 1 }],
  });
  const request: TeachingCommandRequest = { kind: "example", clientKey: randomUUID(), blockId: exampleId, expectedVersion: 1 };
  const command = (input: TeachingCommandRequest = request, spelling = activity.id, sql: Sql = f.sql) =>
    createOpeningTeachingCommandService(sql).execute(f.scope, spelling, input);
  const receipts = () => f.sql`SELECT * FROM opening_help_exposures WHERE activity_id=${activity.id} ORDER BY release_key`;
  const qualify = async (contentVersion: number) => {
    const learning = createOpeningLearningRepository(f.sql), attempts = createOpeningAttemptService(f.sql);
    const session = await learning.createSession(f.scope, { courseId, activityId: activity.id, skillLabel: "多项式求导", sourceIds: [sourceId] });
    const attempt = await attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: questionId, contentVersion } });
    const observation = await attempts.submit(f.scope, attempt.id, { clientKey: randomUUID(), answer: "3x^2", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
    const evidence = await readOpeningLearningEvidenceContext(f.sql, f.scope, observation);
    return { attempt, observation, evidence, eligibility: evaluateEvidenceEligibility(evidence.observation, evidence.context) };
  };
  return { activity, sourceId, chunkId, courseId, exampleId, questionId, blocks, order, unit, content, request, command, receipts, qualify };
}

/** Full workspace graph, including durable receipts and history counters; no canned SQL rows. */
export async function canonicalGraph(f: OpeningFixture) {
  const graph: Record<string, unknown> = {};
  for (const table of ["library_documents", "library_blocks", "library_revisions", "opening_teaching_units",
    "opening_teaching_activity_specs", "opening_teaching_activities", "opening_help_exposures",
    "opening_workspace_history_revisions", "opening_learning_activity_history_revisions",
    "opening_learning_history_revisions", "opening_learning_item_versions", "opening_learning_attempts",
    "opening_learning_observations", "opening_learning_eligibility", "learning_events", "opening_jobs", "opening_outbox", "opening_budget_reservations"]) {
    graph[table] = await f.sql`SELECT to_jsonb(t) AS row FROM ${f.sql(table)} t WHERE workspace_id=${f.scope.workspaceId} ORDER BY to_jsonb(t)::text`;
  }
  return graph;
}

/** A PG-side fault in the real transaction, never a canned query result.
 * Install only in the isolated test database and always remove in finally.
 */
export async function canonicalRollbackFault(f: OpeningFixture, activityId: string, point: "activity" | "receipt") {
  const name = `canonical_fault_${randomUUID().replaceAll("-", "")}`;
  const table = point === "activity" ? "opening_teaching_activities" : "opening_help_exposures";
  await f.sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='opening_teaching_activities' AND NEW.id::text=TG_ARGV[0] THEN
        RETURN NULL;
      ELSIF TG_TABLE_NAME='opening_help_exposures' AND NEW.activity_id::text=TG_ARGV[0] THEN
        RAISE EXCEPTION 'synthetic late receipt failure' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`);
  try {
    await f.sql.unsafe(`CREATE TRIGGER ${name} BEFORE ${point === "activity" ? "UPDATE OF content_version" : "INSERT"}
      ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}('${activityId}')`);
  } catch (error) {
    await f.sql.unsafe(`DROP FUNCTION ${name}()`);
    throw error;
  }
  return async () => {
    await f.sql.unsafe(`DROP TRIGGER ${name} ON ${table}`);
    await f.sql.unsafe(`DROP FUNCTION ${name}()`);
  };
}

/** Avoid exponential copies of historical success snapshots while rotating the real ring.
 * Only nested response snapshots are compacted. Top-level log/map keys, receipts,
 * versions and publication content remain untouched; each eviction is by real commands.
 */
export async function compactReplaySnapshots(f: OpeningFixture, activityId: string) {
  const [row] = await f.sql`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${activityId}`;
  const checkpoint = row!.checkpoint_json;
  for (const success of Object.values(checkpoint.commandReplay ?? {}) as Array<Record<string, unknown>>) {
    success.checkpointJson = {};
    const init = success.clientInit as Record<string, unknown> | undefined;
    if (init) init.checkpointJson = {};
  }
  await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json(checkpoint)} WHERE id=${activityId}`;
}
