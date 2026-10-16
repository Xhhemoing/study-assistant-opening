import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import {
  conversationPlanInputSchema, conversationPlanInspectionSchema, uuidSchema,
  type ConversationPlanInspection, type ConversationPlanMetadata, type ConversationPlanResult, type Scope, type TaskItem,
} from "@aistudy/contracts";
import {
  admitOpeningConversationPlanReplay, assertOpeningConversationPlanCourse, conversationPlanSuggestion, createOpeningPlanningSettingsRepository,
  OpeningPlanError, proposeOpeningLocalPlan, readOpeningConversationPlanCandidate,
} from "@aistudy/database";
import { localDateKeyInZone } from "@aistudy/domain";

class Clarification extends Error {
  constructor(readonly inspection: ConversationPlanInspection) { super("conversation plan needs clarification"); }
}

async function inspectCandidate(
  tx: TransactionSql, scope: Scope, candidate: Awaited<ReturnType<typeof readOpeningConversationPlanCandidate>>, now: Date,
  requestedDate?: string,
): Promise<ConversationPlanInspection> {
  const { settings, invalidStoredSettings } = await createOpeningPlanningSettingsRepository(tx as unknown as Sql).get(scope);
  const timeZone = settings?.timeZone ?? "Asia/Shanghai";
  const date = requestedDate ?? localDateKeyInZone(now, timeZone);
  const [state] = await tx`SELECT accepted_version FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${date}::date`;
  const courses = await tx`SELECT id, title FROM courses WHERE workspace_id=${scope.workspaceId} AND archived_at IS NULL
    ORDER BY title, id LIMIT 100`;
  return conversationPlanInspectionSchema.parse({
    kind: "clarification", candidate: { id: candidate.id, version: 0, title: candidate.title, minutes: candidate.minutes, dueText: candidate.dueText },
    date, timeZone, planningReady: Boolean(settings && !invalidStoredSettings), acceptedVersion: Number(state?.accepted_version ?? 0),
    courses: courses.map(course => ({ id: course.id, name: course.title })),
    missing: ["course", ...(candidate.minutes === null ? ["minutes"] : [])],
  });
}

/** Reuses the existing saved tutor result. This path makes no model call and creates no task. */
export function createConversationPlanService(sql: Sql, options: { now?: () => Date; propose?: typeof proposeOpeningLocalPlan } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async inspect(scope: Scope, candidateId: unknown): Promise<ConversationPlanInspection> {
      const id = uuidSchema.parse(candidateId);
      return sql.begin(async tx => inspectCandidate(tx, scope, await readOpeningConversationPlanCandidate(tx, scope, id), now()));
    },
    async propose(scope: Scope, raw: unknown): Promise<ConversationPlanResult> {
      const input = conversationPlanInputSchema.parse(raw);
      if (input.expectedVersion !== 0) throw new OpeningPlanError("CONFLICT", "对话建议版本已变化，请重新读取。", "task_changed");
      try {
        return await (options.propose ?? proposeOpeningLocalPlan)(sql, scope, {
          date: input.date, expectedAcceptedVersion: input.expectedAcceptedVersion, clientKey: input.clientKey,
        }, {
          now: now(), preserveAll: true, taskIds: [],
          admitReplay: tx => admitOpeningConversationPlanReplay(tx, scope, input.candidateId),
          intent: { kind: "conversation_plan_v1", candidateId: input.candidateId, expectedVersion: input.expectedVersion,
            courseId: input.courseId === undefined ? "needs_choice" : input.courseId, minutes: input.minutes ?? null },
          additional: async tx => {
            const candidate = await readOpeningConversationPlanCandidate(tx, scope, input.candidateId);
            if (candidate.minutes !== null && candidate.minutes > 240) {
              throw new OpeningPlanError("VALIDATION", "该对话建议超过240分钟，请先拆成较短任务后安排。");
            }
            if (candidate.minutes !== null && input.minutes !== undefined && input.minutes !== candidate.minutes) {
              throw new OpeningPlanError("VALIDATION", "预计时长应与已保存的对话建议一致。");
            }
            const minutes = input.minutes ?? candidate.minutes;
            const missing: ConversationPlanInspection["missing"] = [];
            if (input.courseId === undefined) missing.push("course");
            if (minutes === null) missing.push("minutes");
            if (missing.length) throw new Clarification({ ...await inspectCandidate(tx, scope, candidate, now(), input.date), missing });
            const courseId = input.courseId ?? null;
            await assertOpeningConversationPlanCourse(tx, scope, courseId);
            const metadata: ConversationPlanMetadata = {
              kind: "conversation_plan_v1", candidateId: candidate.id, expectedCandidateVersion: 0,
              sourceTurnId: candidate.sourceTurnId, sourceIds: candidate.sourceIds, taskId: randomUUID(),
              title: candidate.title, minutes: minutes!, courseId, dueText: candidate.dueText,
            };
            const task: TaskItem = { id: metadata.taskId, version: 1, title: metadata.title, minutes: metadata.minutes,
              dueAt: null, priority: 0, status: "pending", origin: "agent", ...(courseId ? { courseId } : {}) };
            return { tasks: [task], suggestedTasks: [conversationPlanSuggestion(metadata)], snapshot: { conversationPlan: metadata }, origin: "agent" };
          },
        });
      } catch (error) {
        if (error instanceof Clarification) return error.inspection;
        throw error;
      }
    },
  };
}
