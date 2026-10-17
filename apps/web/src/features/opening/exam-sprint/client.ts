import { examErrorCauseSchema, examSprintCommandSchema, type ExamSprintCommand, type ExamSprintOverview } from "@aistudy/contracts";
import { z } from "zod";

type WithoutKey<T> = T extends unknown ? Omit<T, "clientKey"> : never;
export type ExamSprintIntent = WithoutKey<ExamSprintCommand>;
export type ExamSprintSnapshot = { overview: ExamSprintOverview | null; busy: boolean; error: string | null; uncertain: boolean };

const runSchema = z.object({
  id: z.string(), mode: z.enum(["diagnostic", "practice", "retest", "mock-a", "mock-b"]), questionIds: z.array(z.string()),
  startedAt: z.string(), deadlineAt: z.string().nullable(), completedAt: z.string().nullable(),
});
const attemptSchema = z.object({
  id: z.string(), questionId: z.string(), runId: z.string(), presentedAt: z.string(), answeredAt: z.string().nullable(),
  answer: z.string().nullable(), correct: z.boolean().nullable(), confidence: z.number().nullable(), durationSeconds: z.number().nullable(),
  help: z.array(z.object({ kind: z.enum(["hint", "solution", "external"]), at: z.string() })), errorCause: examErrorCauseSchema.nullable(),
  question: z.object({
    id: z.string(), topicId: z.string(), skillId: z.string(), familyId: z.string(), lessonId: z.string(),
    difficulty: z.enum(["foundation", "transfer"]), prompt: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })), estimatedMinutes: z.number(),
  }),
  feedback: z.object({ answer: z.string(), explanation: z.string() }).nullable(), hint: z.string().nullable(), independent: z.boolean(),
});
// A malformed 2xx response cannot acknowledge a write: validate the HTTP boundary
// before discarding the command's idempotency key or presenting new progress.
const overviewSchema: z.ZodType<ExamSprintOverview> = z.object({
  pack: z.object({
    id: z.string(), version: z.string(), title: z.string(), description: z.string(),
    topics: z.array(z.object({ id: z.string(), title: z.string() })),
    lessons: z.array(z.object({ id: z.string(), topicId: z.string(), title: z.string(), summary: z.string(), steps: z.array(z.string()), workedExample: z.string(), pitfalls: z.array(z.string()) })),
    sourceItems: z.array(z.object({ id: z.string(), topicId: z.string(), label: z.string(), sourceTitle: z.string(), sourcePage: z.number().nullable(), kind: z.enum(["choice", "problem", "exercise"]), suggestedDay: z.number(), skills: z.array(z.string()) })),
    weekPlan: z.array(z.object({ day: z.number(), minutes: z.number(), title: z.string(), tasks: z.array(z.string()) })), limitations: z.array(z.string()),
  }),
  state: z.object({
    version: z.literal(1), startedAt: z.string(), examDate: z.string().nullable(), dailyMinutes: z.number(), runs: z.array(runSchema),
    sourceRecords: z.array(z.object({
      id: z.string(), sourceId: z.string(), phase: z.enum(["first", "blind", "delayed", "variant"]), outcome: z.enum(["correct", "partial", "incorrect", "read"]),
      assistance: z.enum(["none", "hint", "solution"]), durationMinutes: z.number(), errorCause: examErrorCauseSchema.nullable(), note: z.string(), recordedAt: z.string(),
    })),
  }),
  attempts: z.array(attemptSchema), activeRun: runSchema.nullable(), currentAttempt: attemptSchema.nullable(),
  skills: z.array(z.object({ skillId: z.string(), topicId: z.string(), title: z.string(), status: z.enum(["untested", "weak", "usable", "secure"]), independentCorrect: z.number(), attempted: z.number(), dueAt: z.string().nullable(), reason: z.string(), lessonId: z.string() })),
  summary: z.object({ sourceTotal: z.number(), sourceCovered: z.number(), sourceIndependent: z.number(), sourceDelayed: z.number(), onlineAnswered: z.number(), onlineIndependentCorrect: z.number() }),
  recommendations: z.array(z.object({ title: z.string(), reason: z.string(), lessonId: z.string().nullable(), mode: z.enum(["practice", "retest"]) })),
  workload: z.object({ remainingItems: z.number(), estimatedMinutes: z.number().nullable(), availableMinutes: z.number().nullable(), overloaded: z.boolean(), message: z.string() }),
});

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  }
  return status === 401 ? "登录已过期，请重新登录。" : `请求失败（${status}），请稍后重试。`;
}

export function createExamSprintClientKey(): string { return crypto.randomUUID(); }

const uncertainMessage = "上一操作的保存结果尚未确认。请恢复该操作后继续，以免重复记录。";
const describeError = (error: unknown) => error instanceof Error ? error.message : "连接失败，请稍后重试。";

export function createExamSprintClient(options: { fetcher?: typeof fetch; keyFactory?: () => string } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const keyFactory = options.keyFactory ?? createExamSprintClientKey;
  let snapshot: ExamSprintSnapshot = { overview: null, busy: false, error: null, uncertain: false };
  const listeners = new Set<() => void>();
  let generation = 0;
  let active: { generation: number; controller: AbortController; writing: boolean } | null = null;
  let pending: ExamSprintCommand | null = null;

  function publish(update: Partial<ExamSprintSnapshot>) {
    snapshot = { ...snapshot, ...update };
    listeners.forEach(listener => listener());
  }

  function begin(writing: boolean) {
    active?.controller.abort();
    const operation = { generation: ++generation, controller: new AbortController(), writing };
    active = operation;
    publish({ busy: true, error: null });
    return operation;
  }

  const isCurrent = (operation: { generation: number }) => active?.generation === operation.generation;
  function finish(operation: { generation: number }) {
    if (!isCurrent(operation)) return;
    active = null;
    publish({ busy: false });
  }

  async function request(signal: AbortSignal, command?: ExamSprintCommand): Promise<ExamSprintOverview> {
    const response = await fetcher("/api/opening/exam-sprint", {
      method: command ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
      ...(command ? { headers: { "content-type": "application/json" }, body: JSON.stringify(command) } : {}),
    });
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (!response.ok) throw new HttpError(response.status, errorMessage(null, response.status));
      throw new Error("服务器返回了无法识别的数据，请重新读取学习进度。");
    }
    if (!response.ok) throw new HttpError(response.status, errorMessage(body, response.status));
    const result = overviewSchema.safeParse(body);
    if (!result.success) throw new Error("服务器返回的学习进度不完整，请重新读取。");
    return result.data;
  }

  async function load() {
    if (active?.writing) return;
    const operation = begin(false);
    try {
      const overview = await request(operation.controller.signal);
      if (isCurrent(operation)) publish({ overview, error: pending ? uncertainMessage : null });
    } catch (error) {
      if (isCurrent(operation)) publish({ error: describeError(error) });
    } finally { finish(operation); }
  }

  async function write(command: ExamSprintCommand, recovering: boolean) {
    const operation = begin(true);
    try {
      if (recovering) {
        const overview = await request(operation.controller.signal);
        if (!isCurrent(operation)) return;
        publish({ overview });
      }
      const overview = await request(operation.controller.signal, command);
      if (!isCurrent(operation)) return;
      pending = null;
      publish({ overview, error: null, uncertain: false });
    } catch (error) {
      if (!isCurrent(operation)) return;
      const rejected = !recovering && error instanceof HttpError && error.status >= 400 && error.status < 500;
      if (rejected) pending = null;
      publish({ error: rejected ? describeError(error) : `${describeError(error)} ${uncertainMessage}`, uncertain: !rejected });
    } finally { finish(operation); }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    async send(intent: ExamSprintIntent): Promise<void> {
      if (active || pending) return;
      try { pending = examSprintCommandSchema.parse({ ...intent, clientKey: keyFactory() }); }
      catch { publish({ error: "请检查输入内容，暂未提交。" }); return; }
      await write(pending, false);
    },
    async recover(): Promise<void> {
      if (active || !pending) return;
      await write(pending, true);
    },
    // Reusable after React StrictMode's cleanup/remount. Late completions are
    // ignored; an interrupted POST keeps its original command for recovery.
    dispose() {
      const interruptedWrite = active?.writing && pending !== null;
      active?.controller.abort();
      active = null;
      generation++;
      publish({ busy: false, ...(interruptedWrite ? { uncertain: true, error: uncertainMessage } : {}) });
    },
  };
}
