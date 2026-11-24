import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { examPaperInputSchema, type ExamForecastOverview, type ExamPack, type ExamPaper, type ExamPaperInput, type ExamSprintState, type Scope } from "@aistudy/contracts";
import { buildExamSprintForecastBlueprint, forecastExamTopics, toExamSprintForecastEvidence } from "@aistudy/domain";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { learningError, lockLearningOwner, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertExamMaterialAvailable } from "./opening-exam-integration-binding";
import { readCommittedExamReceipt, lockBoundExamCourse, parseExamBinding, readExamEvidenceState } from "./opening-exam-integration-facts";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

const conflict = (message: string) => learningError("CONFLICT", message);

function paperView(row: Record<string, unknown>): ExamPaper {
  const parsed = examPaperInputSchema.safeParse({ clientKey: row.client_key, sourceId: row.source_id,
    sourceVersion: row.source_version, teacher: row.teacher, year: row.year, label: row.label, kind: row.kind, skills: row.skills });
  if (!parsed.success) throw conflict("试卷登记无法校验，请保留数据并联系维护者");
  const { clientKey: _clientKey, ...paper } = parsed.data;
  return { ...paper, id: String(row.id), courseId: String(row.course_id), recordedAt: new Date(row.recorded_at as Date).toISOString() };
}

async function readShortMockReadiness(
  tx: TransactionSql, scope: Scope, pack: ExamPack, snapshot: { id: string; state: ExamSprintState } | null,
): Promise<ExamForecastOverview["shortMockReadiness"]> {
  if (pack.id !== EXAM_SPRINT_PACK.id) return undefined;
  const mockPools = (["mock-a", "mock-b"] as const).filter(pool => pack.questions.some(question => question.pool === pool));
  if (!mockPools.length) return undefined;
  if (!snapshot) return "needs_personal_independent_evidence";
  // Formal evidence can outlive course access or known availability of the pack source.
  const [activeBinding] = await tx`SELECT 1 FROM opening_exam_sprints s
    JOIN opening_exam_bindings b ON b.sprint_id=s.id
    JOIN courses c ON c.id=b.course_id AND c.workspace_id=s.workspace_id AND c.archived_at IS NULL
      AND c.id::text=b.binding->>'courseId'
    JOIN course_asset_memberships m ON m.course_id=c.id AND m.workspace_id=s.workspace_id
      AND m.asset_type='source' AND m.asset_id::text=b.binding->>'packSourceId'
    JOIN opening_sources pack_source ON pack_source.id=m.asset_id AND pack_source.workspace_id=m.workspace_id
      AND pack_source.upload_state='uploaded' AND pack_source.parse_state='ready'
    JOIN opening_source_versions pack_version ON pack_version.workspace_id=pack_source.workspace_id
      AND pack_version.source_id=pack_source.id AND pack_version.version=pack_source.version
      AND pack_version.availability='available'
    WHERE s.id=${snapshot.id} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}`;
  if (!activeBinding) return "needs_personal_independent_evidence";
  const context = await readExamEvidenceState(tx, scope, snapshot.id, snapshot.state);
  const eligible = new Set(context.bktEligibleAttemptIds);
  if (!eligible.size) return "needs_personal_independent_evidence";
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  const examAtMs = new Date(clock!.now as string | Date).getTime();
  // Each form covers different skills. Keep earlier presentations in the state for the first-family check.
  const hasQualifiedEvidence = mockPools.some(pool => toExamSprintForecastEvidence({
    state: snapshot.state, pack, learnerId: scope.ownerUserId, examAtMs, context,
    blueprint: buildExamSprintForecastBlueprint(pack, pool),
  }).some(({ evidenceId, correct }) => {
    const current = context.ruleEvidence[evidenceId];
    return eligible.has(evidenceId) && current?.usable && current.independent && !current.assisted && current.correct === correct;
  }));
  return hasQualifiedEvidence ? "needs_external_calibration" : "needs_personal_independent_evidence";
}

/** Paper annotations describe source material, never learner mastery or official grades. */
export function createOpeningExamForecastRepository(sql: Sql, initialPack: ExamPack) {
  async function overview(tx: TransactionSql, scope: Scope, teacher: string | null): Promise<ExamForecastOverview> {
    await lockLearningOwner(tx, scope);
    const [sprint] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
      WHERE course_id IS NULL AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const snapshot = sprint ? { id: String(sprint.id), ...parseExamSprintSnapshot(sprint.pack_snapshot, sprint.state) } : null;
    const pack = snapshot?.pack ?? initialPack;
    const skillIds = [...new Set(pack.questions.map(question => question.skillId))];
    const shortMockReadiness = await readShortMockReadiness(tx, scope, pack, snapshot);
    const readiness = shortMockReadiness ? { shortMockReadiness } : {};
    if (!snapshot) return { ...forecastExamTopics([], skillIds, teacher), ...readiness };
    // Live membership, current version and privacy checks also apply after registration.
    const rows = await tx`SELECT p.* FROM opening_exam_papers p
      JOIN opening_exam_bindings b ON b.sprint_id=p.sprint_id AND b.course_id=p.course_id
      JOIN courses course ON course.id=p.course_id AND course.workspace_id=p.workspace_id AND course.archived_at IS NULL
      JOIN course_asset_memberships m ON m.course_id=p.course_id AND m.workspace_id=p.workspace_id
        AND m.asset_type='source' AND m.asset_id=p.source_id
      JOIN opening_sources s ON s.id=p.source_id AND s.workspace_id=p.workspace_id AND s.version=p.source_version
      JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=p.source_version
      WHERE p.sprint_id=${snapshot.id} AND p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
        AND s.upload_state='uploaded' AND s.parse_state='ready' AND v.availability='available'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
        AND EXISTS (SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=p.source_version
          AND (c.text ~ '[^[:space:]]' OR (c.image_object_key IS NOT NULL AND c.image_object_key<>'')))
      ORDER BY p.recorded_at,p.id`;
    const papers = rows.map(paperView);
    if (papers.some(paper => paper.skills.some(skill => !skillIds.includes(skill.skillId)))) throw conflict("试卷技能与当前题包不匹配");
    return { ...forecastExamTopics(papers, skillIds, teacher), ...readiness };
  }

  return {
    async read(scope: Scope, teacher: string | null = null): Promise<ExamForecastOverview> {
      return sql.begin(tx => overview(tx, scope, teacher));
    },
    async record(scope: Scope, raw: ExamPaperInput): Promise<ExamForecastOverview> {
      const input = examPaperInputSchema.parse(raw);
      if (input.kind === "past_exam" && input.year > new Date().getUTCFullYear()) {
        throw learningError("VALIDATION", "未来年份的试卷不能登记为历史真卷，请核对年份或材料类型");
      }
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw learningError("NOT_FOUND", "工作区不存在");
        const [existing] = await tx`SELECT intent FROM opening_exam_papers WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
        if (existing) {
          if (!isDeepStrictEqual(existing.intent, input)) throw conflict("同一登记标识不能登记不同试卷内容");
          return readCommittedExamReceipt(async () => {
            await lockBoundExamCourse(tx, scope);
            return overview(tx, scope, input.teacher);
          });
        }
        await lockBoundExamCourse(tx, scope);
        const [sprint] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
          WHERE course_id IS NULL AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!sprint) throw conflict("请先将冲刺绑定课程");
        const [bound] = await tx`SELECT course_id,binding FROM opening_exam_bindings WHERE sprint_id=${String(sprint.id)}`;
        if (!bound) throw conflict("请先将冲刺绑定课程");
        const binding = parseExamBinding(bound.binding), pack = parseExamSprintSnapshot(sprint.pack_snapshot, sprint.state).pack;
        if (binding.courseId !== bound.course_id) throw conflict("课程绑定无法校验");
        const skillIds = new Set(pack.questions.map(question => question.skillId));
        if (input.skills.some(skill => !skillIds.has(skill.skillId))) throw learningError("VALIDATION", "试卷包含题包中不存在的技能");
        await assertExamMaterialAvailable(tx, scope, input.sourceId, input.sourceVersion);
        const [current] = await tx`SELECT version FROM opening_sources WHERE id=${input.sourceId}`;
        if (Number(current?.version) !== input.sourceVersion) throw conflict("试卷材料已更新，请选择当前版本");
        const duplicate = await tx`SELECT id FROM opening_exam_papers WHERE sprint_id=${String(sprint.id)}
          AND source_id=${input.sourceId} AND source_version=${input.sourceVersion}`;
        if (duplicate.length) throw conflict("这份材料版本已经登记，不能作为另一份独立试卷重复计数");
        // Uploading the same bytes again or renaming an identical exam cannot inflate history.
        const repeatedExam = await tx`SELECT p.id FROM opening_exam_papers p
          JOIN opening_source_versions existing ON existing.source_id=p.source_id AND existing.version=p.source_version
            AND existing.workspace_id=p.workspace_id
          JOIN opening_source_versions incoming ON incoming.source_id=${input.sourceId} AND incoming.version=${input.sourceVersion}
            AND incoming.workspace_id=p.workspace_id
          WHERE p.sprint_id=${String(sprint.id)} AND p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
            AND (existing.sha256=incoming.sha256 OR (p.teacher=${input.teacher} AND p.year=${input.year} AND p.label=${input.label}))`;
        if (repeatedExam.length) throw conflict("相同文件或同一老师、年份、考试名称的试卷已经登记，请勿重复计数");
        await tx`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
          VALUES(${scope.workspaceId},${binding.courseId},'source',${input.sourceId},'reference','private')
          ON CONFLICT(course_id,asset_type,asset_id) DO NOTHING`;
        await tx`INSERT INTO opening_exam_papers(id,sprint_id,workspace_id,owner_user_id,course_id,source_id,source_version,
          teacher,year,label,kind,skills,client_key,intent)
          VALUES(${randomUUID()},${String(sprint.id)},${scope.workspaceId},${scope.ownerUserId},${binding.courseId},${input.sourceId},
          ${input.sourceVersion},${input.teacher},${input.year},${input.label},${input.kind},${tx.json(input.skills)},${input.clientKey},${tx.json(input)})`;
        return overview(tx, scope, input.teacher);
      });
    },
  };
}
