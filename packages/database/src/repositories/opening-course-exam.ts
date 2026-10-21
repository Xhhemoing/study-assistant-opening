import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { courseExamInputSchema, courseExamProposalSchema, courseExamSnapshotSchema, openingAdaptivePrefsSchema,
  type CourseExamInput, type CourseExamOverview, type CourseExamProposal, type CourseExamSnapshot, type Scope, type SourceChunk } from "@aistudy/contracts";
import { learningError, lockLearningOwner } from "./opening-learning-facts";
import { proposalTransactionClient } from "./opening-assistant-proposal-effects";
import { createOpeningTeachingActivitiesRepository } from "./opening-teaching-activities";
import { createOpeningTeachingContentRepository } from "./opening-teaching-content";

type ExamRequest = CourseExamSnapshot["requests"][number];
export type CourseExamContext = { request: ExamRequest; courseTitle: string; chunks: SourceChunk[] };
const conflict = (message: string) => learningError("CONFLICT", message);
// The provider is bounded at 240 s. A vanished web process must not leave the
// user waiting forever, and expiry never releases unknown spend or re-sends.
const pendingLifetimeMs = 10 * 60_000;
const expired = (request: ExamRequest, now = Date.now()) => request.status === "pending" && now - Date.parse(request.createdAt) > pendingLifetimeMs;

function snapshot(value: unknown) {
  const parsed = courseExamSnapshotSchema.safeParse(value);
  if (!parsed.success) throw conflict("考前练习记录无法读取，请保留记录并联系维护者。");
  return parsed.data;
}

async function course(tx: TransactionSql, scope: Scope, courseId: string) {
  await lockLearningOwner(tx, scope);
  const [row] = await tx`SELECT c.title,w.privacy_epoch,p.adaptive_planning FROM courses c
    JOIN workspaces w ON w.id=c.workspace_id
    LEFT JOIN workspace_preferences p ON p.workspace_id=c.workspace_id
    WHERE c.id=${courseId} AND c.workspace_id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
      AND c.archived_at IS NULL FOR SHARE OF c,w`;
  if (!row) throw learningError("NOT_FOUND", "课程不存在或已归档。");
  return row;
}

async function availableSources(tx: TransactionSql, scope: Scope, courseId: string) {
  return tx`SELECT s.id,s.name AS title,s.version FROM course_asset_memberships m
    JOIN opening_sources s ON s.id=m.asset_id AND s.workspace_id=m.workspace_id
    JOIN opening_source_versions v ON v.source_id=s.id AND v.version=s.version AND v.workspace_id=s.workspace_id
    WHERE m.course_id=${courseId} AND m.workspace_id=${scope.workspaceId} AND m.asset_type='source'
      AND s.upload_state='uploaded' AND s.parse_state='ready' AND v.availability='available'
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
    ORDER BY m.sort_order,m.created_at,s.id FOR SHARE OF m,s,v`;
}

async function context(tx: TransactionSql, scope: Scope, courseId: string, request: ExamRequest): Promise<CourseExamContext> {
  const c = await course(tx, scope, courseId);
  if (Number(c.privacy_epoch) !== request.privacyEpoch) throw conflict("材料使用设置已变化，请重新选择试卷。");
  const sources = await availableSources(tx, scope, courseId);
  if (!sources.some(source => source.id === request.input.sourceId && Number(source.version) === request.sourceVersion)) {
    throw conflict("试卷已更新、移出课程或不可读取，请重新选择。");
  }
  const rows = await tx`SELECT id,source_id,source_version,page,text FROM opening_source_chunks
    WHERE source_id=${request.input.sourceId} AND source_version=${request.sourceVersion}
      AND (${request.input.firstPage ?? null}::integer IS NULL OR page>=${request.input.firstPage ?? null})
      AND (${request.input.lastPage ?? null}::integer IS NULL OR page<=${request.input.lastPage ?? null})
      AND text ~ '[^[:space:]]' ORDER BY page NULLS LAST,id`;
  if (!rows.length) throw conflict("所选试卷还没有可读取文字，请等待解析完成或调整页码。");
  if (rows.length > 64 || rows.reduce((sum, row) => sum + String(row.text).length, 0) > 48000) {
    throw learningError("VALIDATION", "试卷内容较长，请指定较小的页码范围后再组卷。");
  }
  const chunks = rows.map(row => ({ id: String(row.id), sourceId: String(row.source_id),
    sourceVersion: Number(row.source_version), page: row.page == null ? null : Number(row.page), text: String(row.text),
    startMs: null, endMs: null, imageObjectKey: null }));
  return { request, courseTitle: String(c.title), chunks };
}

/** Course mock papers use ordinary teaching attempts and the shared AI grading/revision loop. */
export function createOpeningCourseExamRepository(sql: Sql) {
  async function located(tx: TransactionSql, scope: Scope, courseId: string, requestId: string, write = false) {
    await course(tx, scope, courseId);
    const rows = write ? await tx`SELECT id,pack_snapshot FROM opening_exam_sprints
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR UPDATE`
      : await tx`SELECT id,pack_snapshot FROM opening_exam_sprints
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR SHARE`;
    if (!rows[0]) throw learningError("NOT_FOUND", "找不到考前练习。");
    const pack = snapshot(rows[0].pack_snapshot), request = pack.requests.find(item => item.id === requestId);
    if (!request) throw learningError("NOT_FOUND", "找不到这次组卷请求。");
    return { sprintId: String(rows[0].id), pack, request };
  }
  return {
    async read(scope: Scope, courseId: string): Promise<CourseExamOverview> {
      return sql.begin(async tx => {
        const c = await course(tx, scope, courseId), sources = await availableSources(tx, scope, courseId);
        const [row] = await tx`SELECT id,pack_snapshot FROM opening_exam_sprints WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR UPDATE`;
        const pack = row ? snapshot(row.pack_snapshot) : null;
        if (pack?.requests.some(request => expired(request))) {
          for (const request of pack.requests) if (expired(request)) request.status = "unknown";
          await tx`UPDATE opening_exam_sprints SET pack_snapshot=${tx.json(pack)},updated_at=now() WHERE id=${String(row!.id)}`;
        }
        const prefs = openingAdaptivePrefsSchema.safeParse(c.adaptive_planning), goal = prefs.success ? prefs.data.courseGoals[courseId] : null;
        return { courseId, courseTitle: String(c.title), targetDate: goal?.targetDate ?? null,
          dailyMinutes: goal ? Math.round(goal.weeklyMinutes / 7) : null,
          sources: sources.map(source => ({ id: String(source.id), title: String(source.title), version: Number(source.version) })),
          papers: (pack?.requests ?? []).map(request => {
            const available = sources.some(source => source.id === request.input.sourceId && Number(source.version) === request.sourceVersion);
            return { id: request.id, clientKey: request.input.clientKey, sourceTitle: available ? request.sourceTitle : "材料已不可用", createdAt: request.createdAt,
              status: request.status, title: available ? request.proposal?.title ?? null : null,
              topics: available ? request.proposal?.topics.map(topic => topic.label) ?? [] : [],
              questionCount: request.input.questionCount, activityId: available ? request.activityId : null, available };
          }).reverse() };
      });
    },
    async begin(scope: Scope, courseId: string, raw: CourseExamInput): Promise<CourseExamContext> {
      const input = courseExamInputSchema.parse(raw);
      return sql.begin(async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const c = await course(tx, scope, courseId);
        const [row] = await tx`SELECT id,pack_snapshot FROM opening_exam_sprints WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR UPDATE`;
        const pack = row ? snapshot(row.pack_snapshot) : { format: "course-exam-v1" as const, requests: [] as ExamRequest[] };
        const existing = pack.requests.find(item => item.input.clientKey === input.clientKey);
        if (existing) {
          if (!isDeepStrictEqual(existing.input, input)) throw conflict("同一组卷请求不能更换材料或题量，请另开一份。");
          if (expired(existing)) {
            existing.status = "unknown";
            await tx`UPDATE opening_exam_sprints SET pack_snapshot=${tx.json(pack)},updated_at=now() WHERE id=${String(row!.id)}`;
          }
          return context(tx, scope, courseId, existing);
        }
        const sources = await availableSources(tx, scope, courseId), source = sources.find(item => item.id === input.sourceId);
        if (!source) throw conflict("请选择本课程内已读取的试卷材料。");
        const request: ExamRequest = { id: randomUUID(), input, sourceVersion: Number(source.version), sourceTitle: String(source.title),
          privacyEpoch: Number(c.privacy_epoch), createdAt: new Date().toISOString(), status: "pending", proposal: null, activityId: null, modelLabel: null };
        const result = await context(tx, scope, courseId, request);
        pack.requests.push(request);
        if (row) await tx`UPDATE opening_exam_sprints SET pack_snapshot=${tx.json(pack)},updated_at=now() WHERE id=${String(row.id)}`;
        else await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,course_id,pack_snapshot,state)
          VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${courseId},${tx.json(pack)},'{}'::jsonb)`;
        return result;
      });
    },
    async assertCurrent(scope: Scope, courseId: string, requestId: string) {
      return sql.begin(async tx => {
        const current = await located(tx, scope, courseId, requestId);
        if (current.request.status !== "pending" || expired(current.request)) throw conflict("组卷请求已结束，请读取已有结果。");
        return context(tx, scope, courseId, current.request);
      });
    },
    async complete(scope: Scope, courseId: string, requestId: string, raw: CourseExamProposal, modelLabel: string | null) {
      const proposal = courseExamProposalSchema.parse(raw);
      return sql.begin(async tx => {
        const current = await located(tx, scope, courseId, requestId, true), { request } = current;
        if (request.status === "ready") return request.activityId!;
        if (request.status !== "pending" || expired(request)) throw conflict("组卷请求已结束。");
        const ctx = await context(tx, scope, courseId, request), chunkIds = new Set(ctx.chunks.map(chunk => chunk.id));
        if (proposal.questions.length !== request.input.questionCount
          || [...proposal.topics, ...proposal.questions].some(item => item.evidenceChunkIds.some(id => !chunkIds.has(id)))
          || proposal.questions.some(question => !proposal.topics.some(topic => topic.label === question.topic))) {
          throw learningError("VALIDATION", "组卷结果的考点、题量或材料引用无法对应，请重新生成。");
        }
        const db = proposalTransactionClient(tx), content = createOpeningTeachingContentRepository(db);
        const activity = await createOpeningTeachingActivitiesRepository(db).create(scope, {
          clientKey: `course-exam:${requestId}`, intentKind: "topic", intentSummary: `${ctx.courseTitle} · ${proposal.title}`,
          courseId, sourceIds: [request.input.sourceId], createIntent: { kind: "course_exam", requestId },
        });
        const blocks = proposal.questions.flatMap((question, index) => [
          { id: randomUUID(), type: "prompt", content: { text: `${index + 1}. ${question.prompt}`, skillLabel: question.topic, estimatedMinutes: question.estimatedMinutes } },
          { id: randomUUID(), type: "answer_key", content: { answer: `${question.referenceAnswer}\n\n评分要点：\n${question.rubric.map(point => `- ${point}`).join("\n")}`,
            hidden: true, hints: question.hints, generated: true } },
        ]);
        const unit = await content.createUnit(scope, { title: proposal.title, blocks, verificationStatus: "needs_check",
          generationConfig: { extras: { kind: "course_exam", requestId, modelLabel } } });
        await content.publishActivitySpec(scope, { activityId: activity.id, teachingUnitId: unit.id,
          expectedVersion: 0, expectedRevisionNumber: unit.currentRevisionNumber, revisionNumber: unit.currentRevisionNumber,
          blockOrder: blocks.map((block, position) => ({ blockId: block.id, position, blockType: block.type, role: block.type as "prompt" | "answer_key" })),
          sourceRefs: ctx.chunks.map(chunk => ({ sourceId: chunk.sourceId, chunkId: chunk.id, version: chunk.sourceVersion, page: chunk.page })),
          verificationStatus: "needs_check" });
        request.status = "ready"; request.proposal = proposal; request.activityId = activity.id; request.modelLabel = modelLabel;
        await tx`UPDATE opening_exam_sprints SET pack_snapshot=${tx.json(current.pack)},updated_at=now() WHERE id=${current.sprintId}`;
        return activity.id;
      });
    },
    async fail(scope: Scope, courseId: string, requestId: string, status: "failed" | "unknown") {
      return sql.begin(async tx => {
        const current = await located(tx, scope, courseId, requestId, true);
        if (current.request.status !== "pending") return;
        current.request.status = status;
        await tx`UPDATE opening_exam_sprints SET pack_snapshot=${tx.json(current.pack)},updated_at=now() WHERE id=${current.sprintId}`;
      });
    },
  };
}
