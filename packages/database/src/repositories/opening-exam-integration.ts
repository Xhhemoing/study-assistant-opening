import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import {
  examBindInputSchema, examSourceMappingInputSchema, openingAdaptivePrefsSchema,
  type ExamBindInput, type ExamCanonicalLink, type ExamIntegrationOverview, type ExamPack, type ExamSourceMappingInput, type Scope,
} from "@aistudy/contracts";
import { createExamSprintState, reportExamBkt } from "@aistudy/domain";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import { ensureExamCourseBinding, type ExamPublicSourceWriter } from "./opening-exam-integration-binding";
import { lockExamCourse, parseExamBinding, readExamBinding, readExamEligibleAttemptIds } from "./opening-exam-integration-facts";
import type { OpeningSourceQuota } from "./opening-source-quota";

type ExamIntegrationOptions = { writePublicSource?: ExamPublicSourceWriter; quota?: OpeningSourceQuota };

async function owner(tx: TransactionSql, scope: Scope, write: boolean) {
  const rows = write ? await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR NO KEY UPDATE`
    : await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!rows.length) throw learningError("NOT_FOUND", "工作区不存在");
}
async function clock(tx: TransactionSql): Promise<string> {
  const [row] = await tx`SELECT clock_timestamp() AS at`;
  return new Date(row!.at as Date).toISOString();
}
async function commandReplay(tx: TransactionSql, sprintId: string, clientKey: string, intent: unknown): Promise<boolean> {
  const [row] = await tx`SELECT intent FROM opening_exam_integration_commands WHERE sprint_id=${sprintId} AND client_key=${clientKey}`;
  if (!row) return false;
  if (!isDeepStrictEqual(row.intent, intent)) throw learningError("CONFLICT", "同一请求标识不能提交不同绑定操作");
  return true;
}
async function receipt(tx: TransactionSql, sprintId: string, clientKey: string, intent: unknown, now: string) {
  await tx`INSERT INTO opening_exam_integration_commands(id,sprint_id,client_key,intent,recorded_at)
    VALUES(${randomUUID()},${sprintId},${clientKey},${tx.json(intent as never)},${now})`;
}

export async function readExamIntegrationInTx(tx: TransactionSql, scope: Scope, pack: ExamPack): Promise<ExamIntegrationOverview> {
  const [row] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const snapshot = row ? parseExamSprintSnapshot(row.pack_snapshot, row.state)
    : { pack, state: createExamSprintState(await clock(tx)) };
  const binding = row ? await readExamBinding(tx, String(row.id)) : null;
  const links = row ? await tx`SELECT exam_attempt_id,learning_attempt_id,observation_id,node_id,requirement_key,publication
    FROM opening_exam_attempt_links WHERE sprint_id=${String(row.id)} ORDER BY learning_attempt_id` : [];
  const mappings = row ? await tx`SELECT source_item_id,skill_ids FROM opening_exam_source_mappings WHERE sprint_id=${String(row.id)}` : [];
  const [preferences] = binding ? await tx`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}` : [];
  const parsed = openingAdaptivePrefsSchema.safeParse(preferences?.adaptive_planning);
  const goal = binding && parsed.success ? parsed.data.courseGoals[binding.courseId] : null;
  const eligible = row && binding ? await readExamEligibleAttemptIds(tx, scope, String(row.id), snapshot.state) : [];
  return {
    binding, links: links.map(link => {
      const attempt = snapshot.state.attempts.find(item => item.id === link.exam_attempt_id);
      const completed = attempt?.answeredAt != null && snapshot.state.runs.some(run => run.id === attempt.runId
        && (run.completedAt !== null || (run.mode !== "mock-a" && run.mode !== "mock-b")));
      return { examAttemptId: String(link.exam_attempt_id), learningAttemptId: String(link.learning_attempt_id),
        observationId: link.observation_id as string | null, nodeId: String(link.node_id), requirementKey: String(link.requirement_key),
        publication: completed && link.publication !== "published" ? "unavailable" : link.publication as ExamCanonicalLink["publication"] };
    }),
    bkt: reportExamBkt(snapshot.state, snapshot.pack, eligible),
    courseGoal: binding && goal ? { targetDate: goal.targetDate, weeklyMinutes: goal.weeklyMinutes,
      milestoneTitle: goal.milestones?.find(milestone => milestone.id === binding.milestoneId)?.title ?? null } : null,
    sourceMappings: snapshot.pack.sourceItems.map(item => {
      const skillIds = (mappings.find(mapping => mapping.source_item_id === item.id)?.skill_ids ?? []) as string[];
      const material = binding?.materials.find(material => material.sourceTitle === item.sourceTitle);
      return { sourceItemId: item.id, skillIds, nodeIds: skillIds.flatMap(id => binding?.skills.find(skill => skill.skillId === id)?.nodeId ?? []),
        sourceId: material?.sourceId ?? null, sourceVersion: material?.sourceVersion ?? null, physicalPage: item.sourcePage };
    }),
  };
}

export function createOpeningExamIntegrationRepository(
  sql: Sql, pack: ExamPack, options: ExamIntegrationOptions = {},
) {
  return {
    async read(scope: Scope): Promise<ExamIntegrationOverview> {
      return sql.begin(async tx => { await owner(tx, scope, false); return readExamIntegrationInTx(tx, scope, pack); });
    },
    async bind(scope: Scope, raw: ExamBindInput): Promise<ExamIntegrationOverview> {
      const input = examBindInputSchema.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await owner(tx, scope, true);
        await lockExamCourse(tx, scope, input.courseId);
        const now = await clock(tx);
        let [row] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!row) {
          const initial = parseExamSprintSnapshot(pack, createExamSprintState(now));
          [row] = await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state,created_at,updated_at)
            VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${tx.json(initial.pack as never)},${tx.json(initial.state as never)},${now},${now}) RETURNING id,pack_snapshot,state`;
        }
        const sprintId = String(row!.id), snapshot = parseExamSprintSnapshot(row!.pack_snapshot, row!.state);
        const intent = { action: "bind", ...input };
        if (await commandReplay(tx, sprintId, input.clientKey, intent)) return readExamIntegrationInTx(tx, scope, snapshot.pack);
        const existing = await readExamBinding(tx, sprintId);
        const binding = await ensureExamCourseBinding(tx, scope, snapshot.pack, input, now, existing ?? undefined, options.writePublicSource, options.quota);
        await tx`INSERT INTO opening_exam_bindings(sprint_id,course_id,binding,updated_at)
          VALUES(${sprintId},${binding.courseId},${tx.json(binding as never)},${now}) ON CONFLICT(sprint_id)
          DO UPDATE SET binding=EXCLUDED.binding,updated_at=EXCLUDED.updated_at`;
        await receipt(tx, sprintId, input.clientKey, intent, now);
        return readExamIntegrationInTx(tx, scope, snapshot.pack);
      });
    },
    async mapSource(scope: Scope, raw: ExamSourceMappingInput): Promise<ExamIntegrationOverview> {
      const input = examSourceMappingInputSchema.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        await owner(tx, scope, true);
        const [located] = await tx`SELECT s.id,b.binding FROM opening_exam_sprints s JOIN opening_exam_bindings b ON b.sprint_id=s.id
          WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}`;
        if (!located) throw learningError("CONFLICT", "请先将冲刺绑定课程");
        const binding = parseExamBinding(located.binding);
        await lockExamCourse(tx, scope, binding.courseId);
        const [row] = await tx`SELECT pack_snapshot,state FROM opening_exam_sprints WHERE id=${String(located.id)} FOR UPDATE`;
        const snapshot = parseExamSprintSnapshot(row!.pack_snapshot, row!.state), intent = { action: "map_source", ...input };
        if (await commandReplay(tx, String(located.id), input.clientKey, intent)) return readExamIntegrationInTx(tx, scope, snapshot.pack);
        if (!snapshot.pack.sourceItems.some(item => item.id === input.sourceItemId) || new Set(input.skillIds).size !== input.skillIds.length
          || input.skillIds.some(id => !binding.skills.some(skill => skill.skillId === id))) throw learningError("VALIDATION", "原题或技能映射无效");
        const now = await clock(tx);
        await tx`INSERT INTO opening_exam_source_mappings(sprint_id,source_item_id,skill_ids,updated_at)
          VALUES(${String(located.id)},${input.sourceItemId},${input.skillIds},${now}) ON CONFLICT(sprint_id,source_item_id)
          DO UPDATE SET skill_ids=EXCLUDED.skill_ids,updated_at=EXCLUDED.updated_at`;
        await receipt(tx, String(located.id), input.clientKey, intent, now);
        return readExamIntegrationInTx(tx, scope, snapshot.pack);
      });
    },
  };
}
export type OpeningExamIntegrationRepository = ReturnType<typeof createOpeningExamIntegrationRepository>;
