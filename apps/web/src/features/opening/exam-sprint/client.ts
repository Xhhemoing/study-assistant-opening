import { examSprintCommandSchema, examBindInputSchema, examSourceMappingInputSchema, examPaperInputSchema, examWorkReviewInputSchema, type ExamSprintCommand, type ExamSprintOverview, type ExamIntegrationOverview, type ExamForecastOverview, type ExamBindInput, type ExamSourceMappingInput, type ExamPaperInput, type ExamWorkReview, type ExamWorkReviewInput } from "@aistudy/contracts";
import { overviewSchema, integrationSchema, forecastSchema, reviewSchema } from "./client-schemas";
import { isCurrentSprintLessonRequest } from "./lesson-navigation";

type WithoutKey<T> = T extends unknown ? Omit<T, "clientKey"> : never;
export type ExamSprintIntent = WithoutKey<ExamSprintCommand>;
export type ExamIntegrationIntent = { action: "bind"; input: WithoutKey<ExamBindInput> } | { action: "map"; input: WithoutKey<ExamSourceMappingInput> } | { action: "paper"; input: WithoutKey<ExamPaperInput> } | { action: "review"; input: WithoutKey<ExamWorkReviewInput> };
export type ExamSprintSnapshot = { overview: ExamSprintOverview | null; integration: ExamIntegrationOverview | null; forecast: ExamForecastOverview | null; review: ExamWorkReview | null; busy: boolean; error: string | null; uncertain: boolean };
type Target = "overview" | "integration" | "forecast" | "review";
type Pending = { target: Target; path: string; method: "POST" | "PATCH"; body: unknown; readTarget?: Target; readPath?: string; lessonRequest?: Extract<ExamSprintCommand, { action: "open_lesson" }> };
const BASE = "/api/opening/exam-sprint";

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

/** All sprint and integration mutations share one lock and one replay envelope. */
export function createExamSprintClient(options: { fetcher?: typeof fetch; keyFactory?: () => string } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const keyFactory = options.keyFactory ?? createExamSprintClientKey;
  let snapshot: ExamSprintSnapshot = { overview: null, integration: null, forecast: null, review: null, busy: false, error: null, uncertain: false };
  const listeners = new Set<() => void>();
  let generation = 0;
  let active: { generation: number; controller: AbortController; writing: boolean } | null = null;
  let pending: Pending | null = null;
  function publish(update: Partial<ExamSprintSnapshot>) { snapshot = { ...snapshot, ...update }; listeners.forEach(listener => listener()); }
  function begin(writing: boolean) {
    active?.controller.abort();
    const operation = { generation: ++generation, controller: new AbortController(), writing };
    active = operation; publish({ busy: true, error: null }); return operation;
  }
  const isCurrent = (operation: { generation: number }) => active?.generation === operation.generation;
  function finish(operation: { generation: number }) { if (isCurrent(operation)) { active = null; publish({ busy: false }); } }
  async function request(signal: AbortSignal, target: Target, path: string, command?: Pending): Promise<Partial<ExamSprintSnapshot>> {
    const response = await fetcher(path, { method: command?.method ?? "GET", credentials: "same-origin", cache: "no-store", signal,
      ...(command ? { headers: { "content-type": "application/json" }, body: JSON.stringify(command.body) } : {}),
    });
    let body: unknown;
    try { body = await response.json(); } catch {
      if (!response.ok) throw new HttpError(response.status, errorMessage(null, response.status));
      throw new Error("服务器返回了无法识别的数据，请重新读取学习进度。");
    }
    if (!response.ok) throw new HttpError(response.status, errorMessage(body, response.status));
    if (target === "overview") { const parsed = overviewSchema.safeParse(body); if (parsed.success) return { overview: parsed.data }; }
    if (target === "integration") { const parsed = integrationSchema.safeParse(body); if (parsed.success) return { integration: parsed.data }; }
    if (target === "forecast") { const parsed = forecastSchema.safeParse(body); if (parsed.success) return { forecast: parsed.data }; }
    if (target === "review") { const parsed = reviewSchema.safeParse(body); if (parsed.success) return { review: parsed.data }; }
    throw new Error("服务器返回的学习进度不完整，请重新读取。");
  }
  async function loadTarget(target: Target, path: string) {
    if (active?.writing) return;
    const operation = begin(false);
    try { const result = await request(operation.controller.signal, target, path); if (isCurrent(operation)) publish({ ...result, error: pending ? uncertainMessage : null }); }
    catch (error) { if (isCurrent(operation)) publish({ error: describeError(error) }); }
    finally { finish(operation); }
  }
  async function write(command: Pending, recovering: boolean) {
    const operation = begin(true);
    try {
      if (recovering) {
        const result = await request(operation.controller.signal, command.readTarget ?? command.target, command.readPath ?? command.path);
        if (!isCurrent(operation)) return;
        publish(result);
        if (command.lessonRequest && result.overview && !isCurrentSprintLessonRequest(result.overview, command.lessonRequest)) {
          pending = null;
          publish({ uncertain: false, error: "已读取最新进度，原串讲请求的训练或内容版本已变更，请重新选择串讲。" });
          return result;
        }
      }
      const result = await request(operation.controller.signal, command.target, command.path, command);
      if (!isCurrent(operation)) return;
      pending = null; publish({ ...result, error: null, uncertain: false });
      return result;
    } catch (error) {
      if (!isCurrent(operation)) return;
      const rejected = !recovering && error instanceof HttpError && error.status >= 400 && error.status < 500;
      if (rejected) pending = null;
      publish({ error: rejected ? describeError(error) : `${describeError(error)} ${uncertainMessage}`, uncertain: !rejected });
    } finally { finish(operation); }
  }
  async function enqueue(build: (key: string) => Pending) {
    if (active || pending) return null;
    try { pending = build(keyFactory()); } catch { publish({ error: "请检查输入内容，暂未提交。" }); return; }
    return await write(pending, false);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => loadTarget("overview", BASE),
    loadIntegration: () => loadTarget("integration", `${BASE}/integration`),
    loadForecast: (teacher = "") => loadTarget("forecast", `${BASE}/forecast${teacher.trim() ? `?teacher=${encodeURIComponent(teacher.trim())}` : ""}`),
    loadReview: (id: string) => loadTarget("review", `${BASE}/reviews?id=${encodeURIComponent(id)}`),
    async send(intent: ExamSprintIntent) {
      const result = await enqueue(clientKey => {
        const body = examSprintCommandSchema.parse({ ...intent, clientKey });
        return { target: "overview", path: BASE, method: "POST", body, ...(body.action === "open_lesson" ? { lessonRequest: body } : {}) };
      });
      return result?.overview ?? null;
    },
    sendIntegration: (intent: ExamIntegrationIntent) => enqueue(clientKey => {
      if (intent.action === "bind") return { target: "integration", path: `${BASE}/integration`, method: "POST", body: examBindInputSchema.parse({ ...intent.input, clientKey }) };
      if (intent.action === "map") return { target: "integration", path: `${BASE}/integration`, method: "PATCH", body: examSourceMappingInputSchema.parse({ ...intent.input, clientKey }) };
      if (intent.action === "review") return { target: "review", path: `${BASE}/reviews`, method: "POST", body: examWorkReviewInputSchema.parse({ ...intent.input, clientKey }), readTarget: "overview", readPath: BASE };
      return { target: "forecast", path: `${BASE}/forecast`, method: "POST", body: examPaperInputSchema.parse({ ...intent.input, clientKey }) };
    }),
    async recover() { if (!active && pending) return (await write(pending, true))?.overview ?? null; return null; },
    dispose() {
      const interruptedWrite = active?.writing && pending !== null;
      active?.controller.abort(); active = null; generation++;
      publish({ busy: false, ...(interruptedWrite ? { uncertain: true, error: uncertainMessage } : {}) });
    },
  };
}
export type ExamSprintClient = ReturnType<typeof createExamSprintClient>;
