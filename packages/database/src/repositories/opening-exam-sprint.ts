import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import {
  examErrorCauseSchema, examSprintCommandSchema,
  type ExamPack, type ExamSprintCommand, type ExamSprintOverview, type ExamSprintState, type Scope,
} from "@aistudy/contracts";
import { applyExamSprintCommand, createExamSprintState, examSprintOverview } from "@aistudy/domain";

const id = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const mode = z.enum(["diagnostic", "practice", "retest", "mock-a", "mock-b"]);
const questionSchema = z.object({
  id, topicId: id, skillId: id, familyId: id, lessonId: id,
  pool: z.enum(["training", "mock-a", "mock-b"]), difficulty: z.enum(["foundation", "transfer"]),
  prompt: z.string(), options: z.array(z.object({ id, label: z.string() }).strict()).min(2),
  answer: id, explanation: z.string(), hint: z.string(), estimatedMinutes: z.number().positive(),
}).strict().refine(question => question.options.some(option => option.id === question.answer)
  && new Set(question.options.map(option => option.id)).size === question.options.length);
const packSchema: z.ZodType<ExamPack> = z.object({
  id, version: id, title: z.string(), description: z.string(),
  topics: z.array(z.object({ id, title: z.string() }).strict()).min(1),
  lessons: z.array(z.object({ id, topicId: id, title: z.string(), summary: z.string(),
    steps: z.array(z.string()), workedExample: z.string(), pitfalls: z.array(z.string()) }).strict()),
  questions: z.array(questionSchema).min(1),
  sourceItems: z.array(z.object({ id, topicId: id, label: z.string(), sourceTitle: z.string(),
    sourcePage: z.number().int().positive().nullable(), kind: z.enum(["choice", "problem", "exercise"]),
    suggestedDay: z.number().int().positive(), skills: z.array(id) }).strict()),
  weekPlan: z.array(z.object({ day: z.number().int().positive(), minutes: z.number().nonnegative(),
    title: z.string(), tasks: z.array(z.string()) }).strict()), limitations: z.array(z.string()),
}).strict();
const stateSchema: z.ZodType<ExamSprintState> = z.object({
  version: z.literal(1), startedAt: timestamp, examDate: date.nullable(), dailyMinutes: z.number().int().min(15).max(720),
  runs: z.array(z.object({ id, mode, questionIds: z.array(id), startedAt: timestamp,
    deadlineAt: timestamp.nullable(), completedAt: timestamp.nullable() }).strict()),
  attempts: z.array(z.object({ id, questionId: id, runId: id, presentedAt: timestamp,
    answeredAt: timestamp.nullable(), answer: z.string().nullable(), correct: z.boolean().nullable(),
    confidence: z.number().int().min(1).max(5).nullable(), durationSeconds: z.number().nonnegative().nullable(),
    help: z.array(z.object({ kind: z.enum(["hint", "solution", "external"]), at: timestamp }).strict()),
    errorCause: examErrorCauseSchema.nullable() }).strict()),
  sourceRecords: z.array(z.object({ id, sourceId: id, phase: z.enum(["first", "blind", "delayed", "variant"]),
    outcome: z.enum(["correct", "partial", "incorrect", "read"]), assistance: z.enum(["none", "hint", "solution"]),
    durationMinutes: z.number().min(0).max(720), errorCause: examErrorCauseSchema.nullable(),
    note: z.string().max(2000), recordedAt: timestamp }).strict()),
}).strict();

export class OpeningExamSprintRepositoryError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT", message: string) {
    super(message);
    this.name = "OpeningExamSprintRepositoryError";
  }
}

function corrupt(): never {
  throw new OpeningExamSprintRepositoryError("CONFLICT", "冲刺记录或题包无法校验，请保留数据并联系维护者");
}
function unique(items: Array<{ id: string }>): boolean {
  return new Set(items.map(item => item.id)).size === items.length;
}
function parseSnapshot(rawPack: unknown, rawState: unknown): { pack: ExamPack; state: ExamSprintState } {
  const parsedPack = packSchema.safeParse(rawPack), parsedState = stateSchema.safeParse(rawState);
  if (!parsedPack.success || !parsedState.success) return corrupt();
  const pack = parsedPack.data, state = parsedState.data;
  if (![pack.topics, pack.lessons, pack.questions, pack.sourceItems, state.runs, state.attempts, state.sourceRecords].every(unique)) return corrupt();
  const topics = new Set(pack.topics.map(topic => topic.id));
  const lessons = new Map(pack.lessons.map(lesson => [lesson.id, lesson]));
  const questions = new Map(pack.questions.map(question => [question.id, question]));
  const runs = new Map(state.runs.map(run => [run.id, run]));
  const sources = new Set(pack.sourceItems.map(source => source.id));
  if (pack.lessons.some(lesson => !topics.has(lesson.topicId))
    || pack.questions.some(question => !topics.has(question.topicId) || lessons.get(question.lessonId)?.topicId !== question.topicId)
    || pack.sourceItems.some(source => !topics.has(source.topicId))
    || state.runs.filter(run => run.completedAt === null).length > 1
    || state.runs.some(run => new Set(run.questionIds).size !== run.questionIds.length
      || run.questionIds.some(questionId => !questions.has(questionId))
      || (run.completedAt !== null && Date.parse(run.completedAt) < Date.parse(run.startedAt)))
    || state.attempts.some(attempt => {
      const question = questions.get(attempt.questionId), run = runs.get(attempt.runId);
      if (!question || !run?.questionIds.includes(attempt.questionId)
        || Date.parse(attempt.presentedAt) < Date.parse(run.startedAt)) return true;
      if (attempt.answeredAt === null) {
        return attempt.answer !== null || attempt.correct !== null || attempt.confidence !== null || attempt.durationSeconds !== null;
      }
      return !question.options.some(option => option.id === attempt.answer)
        || attempt.correct !== (attempt.answer === question.answer) || attempt.confidence === null || attempt.durationSeconds === null
        || Date.parse(attempt.answeredAt) < Date.parse(attempt.presentedAt);
    })
    || new Set(state.attempts.map(attempt => `${attempt.runId}:${attempt.questionId}`)).size !== state.attempts.length
    || state.sourceRecords.some(record => !sources.has(record.sourceId))) return corrupt();
  return { pack, state };
}

async function lockOwner(tx: TransactionSql, scope: Scope, write: boolean) {
  const owner = write
    ? await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`
    : await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner.length) throw new OpeningExamSprintRepositoryError("NOT_FOUND", "工作区不存在");
}
async function nowIso(tx: TransactionSql): Promise<string> {
  const [row] = await tx`SELECT clock_timestamp() AS now`;
  return new Date(row!.now as string | Date).toISOString();
}

export type OpeningExamSprintExport = {
  format: "aistudy-exam-sprint-v1"; exportedAt: string;
  pack: ExamSprintOverview["pack"]; state: ExamSprintOverview["state"]; attempts: ExamSprintOverview["attempts"];
  commands: Array<{ id: string; clientKey: string; intent: ExamSprintCommand; recordedAt: string }>;
};

/** Snapshot + state + command receipts only. Never writes career mastery, BKT, or planner evidence. */
export function createOpeningExamSprintRepository(sql: Sql, pack: ExamPack) {
  // Parse once at the configuration boundary, also detaching caller-owned objects.
  const initialPack = parseSnapshot(pack, createExamSprintState(new Date().toISOString())).pack;

  async function current(tx: TransactionSql, scope: Scope, now: string) {
    const [row] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    const snapshot = row ? parseSnapshot(row.pack_snapshot, row.state)
      : { pack: initialPack, state: createExamSprintState(now) };
    return { id: row ? String(row.id) : null, ...snapshot };
  }

  return {
    async read(scope: Scope): Promise<ExamSprintOverview> {
      return sql.begin(async tx => {
        await lockOwner(tx, scope, false);
        const now = await nowIso(tx), snapshot = await current(tx, scope, now);
        return examSprintOverview(snapshot.state, snapshot.pack, now);
      });
    },

    async act(scope: Scope, raw: ExamSprintCommand): Promise<ExamSprintOverview> {
      const command = examSprintCommandSchema.parse(raw);
      return sql.begin(async tx => {
        // Serialize first-write creation too; a state-row lock alone cannot lock a missing row.
        await lockOwner(tx, scope, true);
        const now = await nowIso(tx);
        const [row] = await tx`SELECT id,pack_snapshot,state FROM opening_exam_sprints
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const snapshot = row ? parseSnapshot(row.pack_snapshot, row.state)
          : { pack: initialPack, state: createExamSprintState(now) };
        const sprintId = row ? String(row.id) : randomUUID();
        const [receipt] = await tx`SELECT intent FROM opening_exam_sprint_commands
          WHERE sprint_id=${sprintId} AND client_key=${command.clientKey}`;
        if (receipt) {
          const parsed = examSprintCommandSchema.safeParse(receipt.intent);
          if (!parsed.success) return corrupt();
          if (!isDeepStrictEqual(parsed.data, command)) {
            throw new OpeningExamSprintRepositoryError("CONFLICT", "同一请求标识不能提交不同操作");
          }
          return examSprintOverview(snapshot.state, snapshot.pack, now);
        }
        const state = applyExamSprintCommand(snapshot.state, command, snapshot.pack, now);
        if (row) {
          await tx`UPDATE opening_exam_sprints SET state=${tx.json(state as never)},updated_at=${now}
            WHERE id=${sprintId}`;
        } else {
          await tx`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state,created_at,updated_at)
            VALUES(${sprintId},${scope.workspaceId},${scope.ownerUserId},${tx.json(snapshot.pack as never)},${tx.json(state as never)},${now},${now})`;
        }
        await tx`INSERT INTO opening_exam_sprint_commands(id,sprint_id,client_key,intent,recorded_at)
          VALUES(${randomUUID()},${sprintId},${command.clientKey},${tx.json(command)},${now})`;
        return examSprintOverview(state, snapshot.pack, now);
      });
    },

    async export(scope: Scope): Promise<OpeningExamSprintExport> {
      return sql.begin(async tx => {
        await lockOwner(tx, scope, false);
        const now = await nowIso(tx), snapshot = await current(tx, scope, now);
        const overview = examSprintOverview(snapshot.state, snapshot.pack, now);
        const rows = snapshot.id ? await tx`SELECT id,client_key,intent,recorded_at FROM opening_exam_sprint_commands
          WHERE sprint_id=${snapshot.id} ORDER BY recorded_at,id` : [];
        const commands = rows.map(row => {
          const parsed = examSprintCommandSchema.safeParse(row.intent);
          if (!parsed.success || parsed.data.clientKey !== row.client_key) return corrupt();
          return { id: String(row.id), clientKey: String(row.client_key), intent: parsed.data,
            recordedAt: new Date(row.recorded_at as string | Date).toISOString() };
        });
        return { format: "aistudy-exam-sprint-v1", exportedAt: now,
          pack: overview.pack, state: overview.state, attempts: overview.attempts, commands };
      });
    },
  };
}

export type OpeningExamSprintRepository = ReturnType<typeof createOpeningExamSprintRepository>;
