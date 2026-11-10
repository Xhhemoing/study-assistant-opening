import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { LearningAttempt } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { createSessionFetch } from "../../auth/session-expiry";
import { createOpeningLearningClient } from "../client/learning-client";
import { currentHistoryRecord } from "../learning/observation-revision-model";
import { createExplicitRegradeHttp, regradeSnapshotSchema, type RegradeServerSnapshot } from "../teaching/explicit-regrade-http";

export const GRADED_ATTEMPT_EXPLANATION_TEXT = "请讲解我这次作答：先说我最早错在哪一步和正确答案，只补这一步缺的知识，再给一道同类题让我自己做。";
const changedMessage = "账户或作答版本已变化，请返回原题重新打开；不会自动重发。";
const receiptSchema = z.object({ version: z.literal(1), owner: z.string(), binding: z.string(),
  clientKey: z.string().min(8).max(200), conversationId: z.string().uuid().nullable(),
  snapshot: regradeSnapshotSchema, phase: z.enum(["creating", "ready", "submitted"]),
}).strict().refine(value => value.phase === "creating" ? value.conversationId === null : value.conversationId !== null);
type Receipt = z.infer<typeof receiptSchema>;

/** The receipt contains identities only, never credentials, question/answer text or model output. */
export function useGradedAttemptExplanation(attempt?: LearningAttempt) {
  const namespace = useRef(getVerifiedSessionNamespace()).current;
  const client = useMemo(() => createOpeningLearningClient(), []);
  const operationScope = `opening:graded-attempt-explain:${namespace}:${attempt?.courseId ?? ""}:${attempt?.id ?? ""}`;
  const [ready, setReady] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const baseline = useRef<RegradeServerSnapshot | null>(null);
  const generation = useRef(0);
  const binding = JSON.stringify([attempt?.id, attempt?.sessionId, attempt?.courseId, attempt?.problemId,
    attempt?.itemVersionId, attempt?.observationId, attempt?.historyRevision, attempt?.contextAnchor]);
  const liveBinding = useRef(binding);
  liveBinding.current = binding;
  const validOwner = () => namespace !== null && getVerifiedSessionNamespace() === namespace;
  async function authorizeOwner() {
    if (!validOwner()) throw new Error(changedMessage);
    const response = await createSessionFetch()("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(changedMessage);
    const body: unknown = await response.json();
    const user = (body as { user?: { id?: string; workspaceId?: string } } | null)?.user;
    if (!validOwner() || JSON.stringify([user?.id, user?.workspaceId]) !== namespace) throw new Error(changedMessage);
  }
  const http = createExplicitRegradeHttp(() => undefined, authorizeOwner);
  function readReceipt(): Receipt | null {
    if (!validOwner()) throw new Error(changedMessage);
    // Older builds wrote only this marker. It cannot identify a recoverable operation.
    if (sessionStorage.getItem(operationScope) !== null) throw new Error("旧操作回执缺少会话与请求键，不能安全新建。");
    const raw = localStorage.getItem(operationScope);
    if (raw === null) return null;
    const parsed = receiptSchema.parse(JSON.parse(raw));
    if (parsed.owner !== namespace || parsed.binding !== binding) throw new Error(changedMessage);
    return parsed;
  }
  function writeReceipt(value: Receipt) {
    if (!validOwner() || liveBinding.current !== binding) throw new Error(changedMessage);
    localStorage.setItem(operationScope, JSON.stringify(receiptSchema.parse(value)));
    setReceipt(value);
  }
  const eligible = Boolean(attempt?.id && attempt.sessionId && attempt.courseId && attempt.problemId
    && attempt.itemVersionId && attempt.observationId);
  useEffect(() => {
    const epoch = ++generation.current;
    baseline.current = null; setReady(false); setReceipt(null); setRecoveryMessage("");
    if (!eligible || !validOwner() || !attempt) return;
    let active = true;
    void (async () => {
      const snapshot = await http.snapshot(attempt.observationId!);
      const history = await client.getObservationHistory(snapshot.rootObservationId);
      const head = currentHistoryRecord(history);
      const evaluation = head.aiEvaluation;
      if (snapshot.oldStatus !== "graded" || snapshot.expectedHead !== history.headObservationId
        || head.revisionKind === "retract" || head.verdictSource !== "ai_graded" || head.outcome !== "incorrect"
        || !evaluation?.questionMatch || evaluation.outcome !== "incorrect"
        || head.attemptId !== attempt.id || head.sessionId !== attempt.sessionId || head.courseId !== attempt.courseId
        || evaluation.attemptId !== attempt.id || evaluation.problemId !== attempt.problemId
        || evaluation.itemVersionId !== attempt.itemVersionId) return;
      await authorizeOwner();
      if (!active || epoch !== generation.current) return;
      const saved = readReceipt();
      if (saved && JSON.stringify(saved.snapshot) !== JSON.stringify(snapshot)) throw new Error(changedMessage);
      baseline.current = snapshot; setReceipt(saved); setReady(true);
      if (saved?.phase === "creating") setRecoveryMessage("会话创建结果尚未确认；现有 API 无创建请求键 GET 恢复，已停止新建，未发送收费讲解。");
    })().catch(() => {
      if (active && epoch === generation.current && validOwner()) setRecoveryMessage("原操作回执或权限无法验证，已停止发送；不会换键重发。");
    });
    const changed = (event: StorageEvent) => {
      if (event.key === operationScope) { setReady(false); setRecoveryMessage("另一标签页已更新本次操作，请重新读取原讲解；不会新建请求。"); }
    };
    const focus = () => { if (baseline.current) void authorize().catch(() => undefined); };
    window.addEventListener("storage", changed);
    window.addEventListener("focus", focus);
    return () => { active = false; generation.current += 1; baseline.current = null; window.removeEventListener("storage", changed); window.removeEventListener("focus", focus); };
  }, [binding, eligible, namespace, client]);

  async function authorize() {
    const base = baseline.current;
    const epoch = generation.current;
    try {
      if (!attempt || !base || !validOwner() || liveBinding.current !== binding) throw new Error(changedMessage);
      const latest = await http.snapshot(attempt.observationId!);
      if (!validOwner() || generation.current !== epoch || liveBinding.current !== binding
        || JSON.stringify(latest) !== JSON.stringify(base)) throw new Error(changedMessage);
    } catch (error) { setReady(false); setRecoveryMessage(changedMessage); throw error; }
  }
  async function withOperationLock(action: () => Promise<void>) {
    // Web Locks are shared by tabs. Storage alone cannot provide compare-and-swap.
    if (!navigator.locks) { setRecoveryMessage("浏览器无法安全协调多标签请求，已停止新建讲解。"); return; }
    await navigator.locks.request(operationScope, { ifAvailable: true }, async lock => {
      if (!lock) return;
      await authorize();
      const saved = readReceipt();
      if (saved) { setReceipt(saved); setRecoveryMessage("已保留原请求，请重新读取原讲解；不会新建收费请求。"); return; }
      await action();
    });
  }
  function begin(clientKey: string) {
    if (!baseline.current) throw new Error(changedMessage);
    writeReceipt({ version: 1, owner: namespace!, binding, clientKey, conversationId: null, snapshot: baseline.current, phase: "creating" });
    setRecoveryMessage("会话创建结果尚未确认；不会盲目新建或发送收费讲解。");
  }
  function bindConversation(conversationId: string) {
    const saved = readReceipt();
    if (!saved || saved.phase !== "creating") throw new Error(changedMessage);
    writeReceipt({ ...saved, conversationId, phase: "ready" });
    setRecoveryMessage("");
  }
  function markStarted() {
    const saved = readReceipt();
    if (!saved?.conversationId) throw new Error(changedMessage);
    writeReceipt({ ...saved, phase: "submitted" });
  }
  return { available: ready && validOwner(), receipt, recoveryMessage, authorize, begin, bindConversation, markStarted, withOperationLock };
}
