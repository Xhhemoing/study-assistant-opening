// Private composition verification fixture, derived from the pinned independent writer SQL model.
// Product service/repository/library/exposure/helper/dispatcher/modules remain real.
// SQL rows and callback rollback are fake; not PG transaction/locking/HTTP acceptance.
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Scope, TeachingBlockRef, TeachingCommandRequest } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createOpeningTeachingCommandService } from "../features/opening/teaching/command-service";
import { readTeachingQuestionForAttempt } from "../../../../packages/database/src/repositories/opening-teaching-question";
import { readOpeningLearningEvidenceContexts } from "../../../../packages/database/src/repositories/opening-learning-evidence-context";
import { mapLearningObservation } from "../../../../packages/database/src/repositories/opening-learning-facts";
type Row = Record<string, unknown>;
type Block = { id: string; type: string; position: number; content: Row };
const id = () => randomUUID();
const at = "2026-01-01T09:00:00.000Z";
const integral = "计算定积分 ∫[0, 2] (x^2 - 1) dx。";

/** Only the SQL boundary is replaced. Unknown queries (including jobs/budgets) fail closed.
 * Lazy thenables distinguish executed queries from postgres template fragments.
 * This models rows/rollback, NOT PostgreSQL parsing, locking or concurrency.
 */
export function databaseNoPriorItem(text = integral) {
  const scope: Scope = { workspaceId: id(), ownerUserId: id() };
  const activityId = id(), documentId = id(), sourceId = id(), blockId = id(), promptId = id(), keyId = id();
  const originalBlocks: Block[] = [
    { id: blockId, type: "example", position: 0, content: { text } },
    { id: promptId, type: "prompt", position: 1, content: { text: "计算 1/4+1/3", skillLabel: "有理数加法" } },
    { id: keyId, type: "answer_key", position: 2, content: { answer: "7/12", hidden: true } },
  ];
  const order: TeachingBlockRef[] = originalBlocks.map(b => ({ blockId: b.id, blockType: b.type,
    role: b.type as "example" | "prompt" | "answer_key", position: b.position }));
  const refs = [{ sourceId, version: 1 }];
  const checkpoint = { drafts: [{ blockId, contentVersion: 1, draftText: "保留中文推导" }], custom: "保留" };
  let state = {
    activity: { id: activityId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
      status: "active", generate_status: "ready", content_version: 1, path_version: 1,
      checkpoint_json: checkpoint as Row, course_id: null, source_ids: [sourceId], goal_json: {}, create_intent: {} },
    spec: { id: id(), activity_id: activityId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
      teaching_unit_id: id(), document_id: documentId, revision_number: 1, block_order: order, source_refs: refs,
      goals_json: [], generation_config: {}, verification_status: "unchecked", version: 1, created_at: at, updated_at: at },
    document: { id: documentId, workspace_id: scope.workspaceId, current_revision_number: 1,
      title: "独立链路", lifecycle: "scratch", schema_version: 1, created_at: at, updated_at: at, deleted_at: null },
    revisions: [{ id: id(), workspace_id: scope.workspaceId, document_id: documentId, revision_number: 1,
      parent_revision_number: null as number | null, title: "独立链路", lifecycle: "scratch", reason: "create", blocks: originalBlocks, created_at: at }],
    projection: structuredClone(originalBlocks), receipts: [] as Row[], sourceVersion: 1, unitVersion: 1, history: 0,
  };
  const queries: string[] = [];
  let evidenceMode = false;
  const observation = mapLearningObservation({ id: id(), workspace_id: scope.workspaceId, session_id: id(), course_id: id(),
    skill_label: "有理数加法", source_ids: [sourceId], source_versions: { [sourceId]: 1 },
    problem_id: id(), item_version_id: id(), attempt_id: id(), answer: "7/12", outcome: "correct",
    assistance: "independent", client_key: id(), occurred_at: "2026-01-01T10:01:00Z",
    started_at: "2026-01-01T10:00:00Z", submitted_at: "2026-01-01T10:01:00Z", recorded_at: "2026-01-01T10:01:00Z",
    verdict_source: "self_report", source_turn_ids: [], history_revision: 10 });

  function execute(q: string, v: readonly unknown[]): Row[] {
    queries.push(q);
    if (q.includes("a.source_ids AS activity_source_ids")) return [{ ...state.spec,
      content_version: state.activity.content_version, status: state.activity.status,
      activity_source_ids: state.activity.source_ids, revision_id: state.revisions.at(-1)!.id,
      blocks: state.revisions.at(-1)!.blocks }];
    if (evidenceMode) {
      if (q.includes("FROM opening_study_intent_events") || q.includes("FROM (?) identity")
        || q.includes("opening_exam_attempt_links") || q.includes("opening_privacy_exclusions")) return [];
      if (q.includes("FROM opening_learning_sessions")) return [{ id: observation.sessionId, course_id: observation.courseId }];
      // Exact anchor branch only. This scenario has no old item rows at all:
      // unchangedTeachingQuestionHelpMatches EXISTS(prior item) is false.
      // No attempt/session/problem/source or originReference associations exist on these receipts.
      if (q.includes("FROM opening_help_exposures h LEFT JOIN")) return state.receipts.filter(r => {
        const a = r.context_anchor as { activityId: string; blockId: string; contentVersion: number };
        return a.activityId === activityId && a.blockId === promptId && a.contentVersion === state.spec.version;
      }).map(r => ({ ...r, course_id: observation.courseId }));
      if (q.startsWith("SELECT id,root_observation_id,revises_observation_id,answer")) return [{
        id: observation.id, answer: observation.answer, recorded_at: observation.recordedAt,
        workspace_history_revision: 10, source_ids: observation.sourceIds, source_versions: observation.sourceVersions,
      }];
      if (q.includes("FROM opening_learning_observations") || q.includes("o.verdict_source")) return [];
      if (q.includes("FROM opening_source_versions")) return [{ source_id: sourceId, version: 1, availability: "available" }];
      if (q.includes("FROM opening_sources")) return [{ id: sourceId, version: state.sourceVersion, upload_state: "uploaded" }];
      if (q.includes("FROM opening_learning_item_versions v")) return [{ id: observation.itemVersionId,
        problem_id: observation.problemId, teaching_revision_id: state.revisions.at(-1)!.id, teaching_block_id: promptId,
        evaluation_spec: { kind: "teaching_question", activityId, blockId: promptId, contentVersion: state.spec.version } }];
      throw new Error(`Unmodeled evidence SQL: ${q}`);
    }
    if (q.startsWith("SELECT h.id,h.context_anchor,h.release_intent FROM opening_help_exposures h")) return state.receipts.filter(r =>
      r.delivered === true && r.released_at != null && r.kind === "solution" && r.level === "revealed"
      && String(r.release_key).startsWith("teaching-example:") && r.attempt_id == null && r.problem_id == null && r.item_version_id == null
      && (r.context_anchor as { contentVersion: number }).contentVersion === Number(v[3]));
    if (q.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (q.includes("opening_workspace_history_revisions")) {
      if (q.startsWith("UPDATE")) state.history++;
      return [{ revision: state.history }];
    }
    if (q.includes("FROM opening_teaching_activities a") || q.startsWith("SELECT * FROM opening_teaching_activities")
      || q.startsWith("SELECT course_id") || q.startsWith("SELECT source_ids")) return [state.activity];
    if (q.startsWith("SELECT * FROM opening_teaching_activity_specs") || q.startsWith("SELECT block_order,source_refs,version")) return [state.spec];
    if (q.startsWith("SELECT current_revision_number FROM opening_teaching_units")) return [{ current_revision_number: state.unitVersion }];
    if (q.startsWith("SELECT s.id,s.version,s.bytes,s.sha256")) return [{ id: sourceId, version: state.sourceVersion }];
    if (q.startsWith("SELECT s.id FROM opening_sources")) return [{ id: sourceId }];
    if (q.startsWith("SELECT * FROM library_documents")) return [state.document];
    if (q.startsWith("SELECT ? AS readable")) return [{ readable: true }];
    if (q.startsWith("SELECT * FROM library_revisions")) return state.revisions.filter(r => r.revision_number === v[2]);
    if (q.startsWith("SELECT blocks FROM library_revisions")) return state.revisions;
    if (q.startsWith("UPDATE library_documents")) {
      state.document.current_revision_number = Number(v[2]); return [state.document];
    }
    if (q.startsWith("DELETE FROM library_blocks")) { state.projection = []; return []; }
    if (q.startsWith("INSERT INTO library_blocks")) {
      state.projection.push({ id: String(v[0]), type: String(v[3]), position: Number(v[4]), content: v[5] as Row }); return [];
    }
    if (q.startsWith("INSERT INTO library_revisions")) {
      state.revisions.push({ id: id(), workspace_id: scope.workspaceId, document_id: documentId,
        revision_number: Number(v[3]), parent_revision_number: Number(v[4]), title: String(v[5]), lifecycle: String(v[6]),
        reason: String(v[7]), blocks: v[8] as Block[], created_at: at }); return [];
    }
    if (q.startsWith("SELECT id, type, position, content FROM library_blocks")) return state.projection;
    if (q.startsWith("UPDATE opening_teaching_activity_specs")) {
      Object.assign(state.spec, { revision_number: v[0], block_order: v[1], version: v[2] }); return [state.spec];
    }
    if (q.startsWith("UPDATE opening_teaching_units")) { state.unitVersion = Number(v[0]); return []; }
    if (q.startsWith("UPDATE opening_teaching_activities SET content_version")) {
      Object.assign(state.activity, { content_version: v[0], checkpoint_json: v[1] }); return [state.activity];
    }
    if (q.startsWith("UPDATE opening_teaching_activities SET checkpoint_json")) {
      state.activity.checkpoint_json = v[0] as Row; return [state.activity];
    }
    if (q.startsWith("SELECT id FROM opening_help_exposures")) return state.receipts.filter(r => r.release_key === v[2]);
    if (q.startsWith("SELECT * FROM opening_help_exposures")) return state.receipts.filter(r =>
      q.includes("release_key=") ? r.release_key === v[1] : r.id === v[0]);
    if (q.startsWith("INSERT INTO opening_help_exposures") && q.includes("FROM opening_help_exposures h WHERE h.id=")) {
      const prior = state.receipts.find(row => row.id === v[4]);
      if (prior && !state.receipts.some(row => row.release_key === v[1])) state.receipts.push({ ...structuredClone(prior),
        id: v[0], release_key: v[1], release_intent: v[2], context_anchor: v[3] });
      return [];
    }
    if (q.startsWith("INSERT INTO opening_help_exposures")) {
      const row = { id: v[0], workspace_id: v[1], owner_user_id: v[2], course_id: v[3], session_id: v[4], attempt_id: v[5],
        problem_id: v[6], item_version_id: v[7], activity_id: v[8], turn_id: v[9], kind: v[10], level: v[11],
        delivered: false, release_key: v[12], release_intent: v[13], context_anchor: v[14], exposure_origin: v[15],
        support_domain: v[16], hint_stage: v[17], initiated_by: v[18], help_input_snapshot: v[19],
        generated_at: at, released_at: null, history_revision: 0 };
      state.receipts.push(row); return [row];
    }
    if (q.startsWith("UPDATE opening_help_exposures")) {
      const row = state.receipts.find(r => r.id === v[2])!;
      Object.assign(row, { delivered: true, released_at: at, delivered_at: at, history_revision: v[0], workspace_history_revision: v[1] });
      return [row];
    }
    if (q.startsWith("SELECT DISTINCT COALESCE(o.root_observation_id,o.id)")) return [];
    throw new Error(`Unmodeled command SQL: ${q}`);
  }
  const callable = Object.assign((strings: TemplateStringsArray | readonly unknown[], ...values: unknown[]) => {
    if (!("raw" in strings)) return { values: strings };
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    return { then: <T, U>(resolve: (rows: Row[]) => T, reject: (error: unknown) => U) =>
      Promise.resolve().then(() => execute(q, values)).then(resolve, reject) };
  }, { json: (value: unknown) => value,
    begin: async <T>(run: (tx: Sql) => Promise<T>) => {
      const before = structuredClone(state);
      try { return await run(sql); } catch (error) { state = before; throw error; }
    } });
  // The sole structural cast is the external driver's overloaded callable surface.
  const sql = callable as unknown as Sql & TransactionSql;
  const service = createOpeningTeachingCommandService(sql);
  return { scope, activityId, blockId, promptId, keyId, queries, observation,
    state: () => state,
    command: (request?: TeachingCommandRequest) => service.execute(scope, activityId, request ?? { kind: "example", clientKey: id(), blockId,
      expectedVersion: state.activity.content_version, expectedPathVersion: 1, expectedRevisionNumber: state.spec.revision_number }),
    publishChanged: (change: (draft: typeof state) => void) => {
      // Model a separate legitimate publication, NOT a mutation of an immutable
      // old revision. No receipt or item is created by this SQL-row fixture.
      const next = structuredClone(state.revisions.at(-1)!);
      next.id = id(); next.parent_revision_number = next.revision_number; next.revision_number++;
      state.revisions.push(next);
      state.spec.version++; state.spec.revision_number++;
      state.activity.content_version++; state.unitVersion++; state.document.current_revision_number++;
      change(state);
    },
    readQuestion: () => readTeachingQuestionForAttempt(sql, scope, activityId,
      { blockId: promptId, contentVersion: state.activity.content_version }, { [sourceId]: state.sourceVersion }),
    qualify: async () => {
      evidenceMode = true;
      try {
        const inputs = await readOpeningLearningEvidenceContexts(sql, scope, [observation]);
        const input = inputs[observation.id]!;
        return { input, result: evaluateEvidenceEligibility(input.observation, input.context) };
      } finally { evidenceMode = false; }
    },
  };
}
