import { useEffect, useMemo, useRef, useState } from "react";
import type { LearningAttempt } from "@aistudy/contracts";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { createSessionFetch } from "../../auth/session-expiry";
import { createOpeningLearningClient } from "../client/learning-client";
import { currentHistoryRecord } from "../learning/observation-revision-model";
import { createExplicitRegradeHttp, type RegradeServerSnapshot } from "../teaching/explicit-regrade-http";

export const GRADED_ATTEMPT_EXPLANATION_TEXT = "请讲解我这次作答：先说我最早错在哪一步和正确答案，只补这一步缺的知识，再给一道同类题让我自己做。";
const changedMessage = "账户或作答版本已变化，请返回原题重新打开；不会自动重发。";

/** GET-only discovery. Click-time checks fence both conversation creation and turn submission. */
export function useGradedAttemptExplanation(attempt?: LearningAttempt) {
  const namespace = useRef(getVerifiedSessionNamespace()).current;
  const client = useMemo(() => createOpeningLearningClient(), []);
  // A reload cannot prove an earlier POST was not accepted. Keep only a non-sensitive
  // operation marker; recovering/retrying a known turn remains the existing conversation flow.
  const operationScope = `opening:graded-attempt-explain:${namespace}:${attempt?.courseId ?? ""}:${attempt?.id ?? ""}`;
  const [reloadedOperation] = useState(() => {
    try { return typeof window === "undefined" || sessionStorage.getItem(operationScope) !== null; }
    catch { return true; }
  });
  const [ready, setReady] = useState(false);
  const baseline = useRef<RegradeServerSnapshot | null>(null);
  const generation = useRef(0);
  const binding = JSON.stringify([attempt?.id, attempt?.sessionId, attempt?.courseId, attempt?.problemId,
    attempt?.itemVersionId, attempt?.observationId, attempt?.historyRevision, attempt?.contextAnchor]);
  const liveBinding = useRef(binding);
  liveBinding.current = binding;
  const validOwner = () => namespace !== null && getVerifiedSessionNamespace() === namespace;
  const http = createExplicitRegradeHttp(() => undefined, async () => {
    if (!validOwner()) throw new Error(changedMessage);
  });
  const eligible = Boolean(attempt?.id && attempt.sessionId && attempt.courseId && attempt.problemId
    && attempt.itemVersionId && attempt.observationId);
  useEffect(() => {
    const epoch = ++generation.current;
    baseline.current = null; setReady(false);
    if (!eligible || !validOwner() || !attempt) return;
    let active = true;
    void (async () => {
      const snapshot = await http.snapshot(attempt.observationId!);
      const history = await client.getObservationHistory(snapshot.rootObservationId);
      const head = currentHistoryRecord(history);
      // The real enum has no partial outcome: only a matched AI-graded incorrect answer qualifies.
      const evaluation = head.aiEvaluation;
      if (snapshot.oldStatus !== "graded" || snapshot.expectedHead !== history.headObservationId
        || head.revisionKind === "retract" || head.verdictSource !== "ai_graded" || head.outcome !== "incorrect"
        || !evaluation?.questionMatch || evaluation.outcome !== "incorrect"
        || head.attemptId !== attempt.id || head.sessionId !== attempt.sessionId || head.courseId !== attempt.courseId
        || evaluation.attemptId !== attempt.id || evaluation.problemId !== attempt.problemId
        || evaluation.itemVersionId !== attempt.itemVersionId) return;
      if (active && epoch === generation.current && validOwner()) { baseline.current = snapshot; setReady(true); }
    })().catch(() => { /* Unreadable ownership or grading is not permission to send. */ });
    return () => { active = false; generation.current += 1; baseline.current = null; };
    // Discovery is keyed to the full saved attempt identity, never a POST or an automatic retry.
  }, [binding, eligible, namespace, client]);

  async function authorize() {
    const base = baseline.current;
    const epoch = generation.current;
    if (!attempt || !ready || !base || !validOwner() || liveBinding.current !== binding) throw new Error(changedMessage);
    const response = await createSessionFetch()("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) { setReady(false); throw new Error(changedMessage); }
    const body: unknown = await response.json();
    const user = (body as { user?: { id?: string; workspaceId?: string } } | null)?.user;
    if (JSON.stringify([user?.id, user?.workspaceId]) !== namespace) { setReady(false); throw new Error(changedMessage); }
    const latest = await http.snapshot(attempt.observationId!);
    if (!validOwner() || generation.current !== epoch || liveBinding.current !== binding
      || JSON.stringify(latest) !== JSON.stringify(base)) { setReady(false); throw new Error(changedMessage); }
  }
  function markStarted() {
    if (reloadedOperation || !validOwner()) throw new Error(changedMessage);
    try { sessionStorage.setItem(operationScope, "started"); }
    catch { setReady(false); throw new Error("无法保留本次请求状态，已停止发送；请勿重复新建讲解。"); }
  }
  return { available: ready && validOwner(), reloadedOperation, authorize, markStarted };
}
