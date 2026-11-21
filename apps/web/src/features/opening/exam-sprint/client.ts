import { examSprintCommandSchema, examBindInputSchema, examSourceMappingInputSchema, examPaperInputSchema, examWorkReviewInputSchema, type ExamSprintCommand, type ExamSprintOverview, type ExamIntegrationOverview, type ExamForecastOverview, type ExamBindInput, type ExamSourceMappingInput, type ExamPaperInput, type ExamWorkReview, type ExamWorkReviewInput } from "@aistudy/contracts";
import { overviewSchema, integrationSchema, forecastSchema, reviewSchema } from "./client-schemas";
import { sprintRecoveryStore } from "./recovery-store";
import { isCurrentSprintLessonRequest } from "./lesson-navigation";
import { userFacingMessage } from "../../../lib/user-facing-error";

type WithoutKey<T> = T extends unknown ? Omit<T, "clientKey"> : never;
export type ExamSprintIntent = WithoutKey<ExamSprintCommand>;
export type ExamIntegrationIntent = { action: "bind"; input: WithoutKey<ExamBindInput> } | { action: "map"; input: WithoutKey<ExamSourceMappingInput> } | { action: "paper"; input: WithoutKey<ExamPaperInput> } | { action: "review"; input: WithoutKey<ExamWorkReviewInput> };
export type ExamSprintSnapshot = { overview: ExamSprintOverview | null; integration: ExamIntegrationOverview | null; forecast: ExamForecastOverview | null; review: ExamWorkReview | null; busy: boolean; error: string | null; uncertain: boolean };
type Target = "overview" | "integration" | "forecast" | "review";
type Pending = { target: Target; path: string; method: "POST" | "PATCH"; body: { clientKey: string }; readTarget?: Target; readPath?: string; lessonRequest?: Extract<ExamSprintCommand, { action: "open_lesson" }> };
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
export function createExamSprintClientKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// The sprint routes reject invalid input, missing resources, conflicts and oversized bodies.
// Other failures can precede the receipt lookup and leave an earlier attempt unresolved.
const terminalWriteStatuses = new Set([400, 404, 409, 413]);
const uncertainMessage = "上一操作的保存结果尚未确认。请恢复该操作后继续，以免重复记录。";
const describeError = (error: unknown) => userFacingMessage(error, "连接失败，请稍后重试。");
const isResolvedReview = (review: ExamWorkReview) => review.status === "ready" || review.status === "failed";

function fallbackFingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x85ebca6b);
    c = Math.imul(c ^ byte, 0xc2b2ae35);
    d = Math.imul(d ^ byte, 0x27d4eb2d);
  }
  return [a, b, c, d, a ^ c, b ^ d, a ^ b, c ^ d]
    .map(value => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

async function fingerprintFor(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    } catch { /* Use the deterministic local fallback below. */ }
  }
  return fallbackFingerprint(bytes);
}

/** All sprint and integration mutations share one lock and one replay envelope. */
export function createExamSprintClient(options: { workspaceId?: string; courseId?: string; fetcher?: typeof fetch; keyFactory?: () => string } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const keyFactory = options.keyFactory ?? createExamSprintClientKey;
  let snapshot: ExamSprintSnapshot = { overview: null, integration: null, forecast: null, review: null, busy: false, error: null, uncertain: false };
  const listeners = new Set<() => void>();
  let generation = 0;
  let active: { generation: number; controller: AbortController; writing: boolean } | null = null;
  let pending: Pending | null = null;
  let fingerprint = "";
  let recovery: ReturnType<typeof sprintRecoveryStore> | undefined;
  const unresolvedReviews = new Map<string, { fingerprint: string; clientKey: string }>();
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
    if (!response.ok || (command && response.status !== 200)) throw new HttpError(response.status, errorMessage(body, response.status));
    if (target === "overview") { const parsed = overviewSchema.safeParse(body); if (parsed.success) return { overview: parsed.data }; }
    if (target === "integration") { const parsed = integrationSchema.safeParse(body); if (parsed.success) return { integration: parsed.data }; }
    if (target === "forecast") { const parsed = forecastSchema.safeParse(body); if (parsed.success) return { forecast: parsed.data }; }
    if (target === "review") { const parsed = reviewSchema.safeParse(body); if (parsed.success) return { review: parsed.data }; }
    throw new Error("服务器返回的学习进度不完整，请重新读取。");
  }
  async function loadTarget(target: Target, path: string) {
    if (active?.writing) return;
    const operation = begin(false);
    try {
      const result = await request(operation.controller.signal, target, path);
      if (!isCurrent(operation)) return;
      if (result.review && isResolvedReview(result.review)) {
        const receipt = unresolvedReviews.get(result.review.id);
        if (receipt) {
          recovery?.confirm(receipt.fingerprint, receipt.clientKey);
          unresolvedReviews.delete(result.review.id);
        }
      }
      publish({ ...result, error: pending ? uncertainMessage : null });
    } catch (error) { if (isCurrent(operation)) publish({ error: describeError(error) }); }
    finally { finish(operation); }
  }
  async function write(command: Pending, recovering: boolean, operation = begin(true)) {
    const readState = () => request(operation.controller.signal, command.readTarget ?? command.target, command.readPath ?? command.path);
    let writeAttempted = false;
    try {
      if (recovering) {
        const result = await readState();
        if (!isCurrent(operation)) return;
        publish(result);
        if (command.lessonRequest && result.overview && !isCurrentSprintLessonRequest(result.overview, command.lessonRequest)) {
          pending = null;
          publish({ uncertain: false, error: "题包内容刚更新过，请重新选择串讲。" });
          return result;
        }
      }
      writeAttempted = true;
      const result = await request(operation.controller.signal, command.target, command.path, command);
      if (!isCurrent(operation)) return;
      if (result.review && !isResolvedReview(result.review)) {
        // The POST returned a receipt, but the paid review is still unresolved.
        unresolvedReviews.set(result.review.id, { fingerprint, clientKey: command.body.clientKey });
      } else {
        recovery?.confirm(fingerprint, command.body.clientKey);
        if (result.review) unresolvedReviews.delete(result.review.id);
      }
      pending = null; publish({ ...result, error: null, uncertain: false });
      return result;
    } catch (error) {
      if (!isCurrent(operation)) return;
      const rejected = writeAttempted && error instanceof HttpError && terminalWriteStatuses.has(error.status);
      if (!rejected) {
        publish({ error: `${describeError(error)} ${uncertainMessage}`, uncertain: true });
        return;
      }

      pending = null;
      const message = describeError(error);
      publish({ error: message, uncertain: false });
      if (recovering && (error.status === 404 || error.status === 409)) {
        // Another tab can finish the run between the recovery read and the replay.
        try {
          const latest = await readState();
          if (isCurrent(operation)) publish(latest);
        } catch {
          if (isCurrent(operation)) publish({ error: `${message} 请重新读取最新进度。` });
        }
      }
    } finally { finish(operation); }
  }
  async function enqueue(build: (key: string) => Pending) {
    if (active || pending) return null;
    const operation = begin(true);
    try {
      // Fingerprint the normalized wire intent, including the endpoint and method.
      const command = build("compare-intent");
      const { clientKey: _key, ...intent } = command.body;
      const bytes = new TextEncoder().encode(JSON.stringify([command.path, command.method, intent]));
      const digest = await fingerprintFor(bytes);
      if (!isCurrent(operation)) return;
      fingerprint = digest;
      recovery ??= sprintRecoveryStore(options.workspaceId, options.courseId);
      const keySchema = command.target === "review" ? examWorkReviewInputSchema.shape.clientKey : examBindInputSchema.shape.clientKey;
      command.body.clientKey = keySchema.parse(recovery.get(fingerprint) ?? keyFactory());
      pending = command;
      // Persist before dispatch so closing the tab view cannot orphan a committed receipt.
      recovery.remember(fingerprint, pending.body.clientKey, { protected: command.target === "review" });
    } catch {
      if (isCurrent(operation)) publish({ error: "请检查输入内容，暂未提交。" });
      finish(operation);
      return;
    }
    return await write(pending, false, operation);
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
