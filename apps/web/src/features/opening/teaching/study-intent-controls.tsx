"use client";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { studyIntentEventSchema, studySessionIntentSchema, type LearningAttempt, type StudyIntentChange, type StudyIntentEvent, type StudySessionIntent } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { ExplanationActions, explanationActionPrompt } from "./explanation-actions";
import { LessonSelectionAskContext } from "./selection-ask";
const resultSchema = z.object({ event: studyIntentEventSchema, currentEvent: studyIntentEventSchema, currentIntent: studySessionIntentSchema, currentVersion: z.number().int().positive(),
  move: z.object({ id: z.string(), presentation: z.object({ instructions: z.string() }), studentAction: z.string() }) });
export function StudyIntentControls({ attempt, desiredIntent, currentIntent, onApplied }: { attempt: Pick<LearningAttempt, "sessionId" | "courseId"> & { id?: string }; desiredIntent?: StudySessionIntent; currentIntent?: StudySessionIntent;
  onApplied?: (intent: StudySessionIntent, action: StudyIntentEvent["action"], newEvidenceEventId?: string) => void }) {
  const diagnostics = useDiagnosticsEnabled();
  const askExplanation = useContext(LessonSelectionAskContext);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [receipt, setReceipt] = useState<z.infer<typeof resultSchema> | null>(null);
  const [knownEvent, setKnownEvent] = useState<StudyIntentEvent | null>(null);
  const onAppliedRef = useRef(onApplied); onAppliedRef.current = onApplied;
  const desiredKey = desiredIntent ? JSON.stringify(desiredIntent) : "";
  const lastPreference = useRef(desiredKey);
  const keys = useRef(new Map<string, string>());
  const busy = useRef(false);
  const mutation = useRef(0), watermark = useRef(0);
  const queuedPreference = useRef<StudyIntentChange | null>(null);
  const applyRef = useRef<(change: StudyIntentChange) => Promise<void>>(async () => undefined);
  const unresolved = useRef<string | null>(null);
  const lastChange = useRef<StudyIntentChange | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/opening/study/intent?sessionId=${attempt.sessionId}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("学习意图暂不可读取");
      const result = z.object({ event: studyIntentEventSchema.nullable() }).parse(await response.json());
      if (!controller.signal.aborted && mutation.current === 0 && result.event && result.event.version >= watermark.current) { watermark.current = result.event.version; setKnownEvent(result.event); if (currentIntent && JSON.stringify(result.event.intent) === JSON.stringify(currentIntent)) { lastPreference.current = JSON.stringify(currentIntent); onAppliedRef.current?.(result.event.intent, "continue"); } }
    }).catch(reason => { if (!controller.signal.aborted) setError(userFacingMessage(reason, "意图暂不可读取")); });
    return () => controller.abort();
  }, [attempt.sessionId, currentIntent]);
  const apply = useCallback(async (change: StudyIntentChange) => {
    const identity = JSON.stringify(change);
    if (busy.current || (unresolved.current && unresolved.current !== identity)) {
      if (change.kind === "preference") queuedPreference.current = change;
      return;
    }
    mutation.current += 1;
    lastChange.current = change;
    busy.current = true; setPending(true); setError("");
    let clientKey = keys.current.get(identity);
    if (!clientKey) { clientKey = `study-intent:${crypto.randomUUID()}`; keys.current.set(identity, clientKey); }
    let confirmed = false;
    try {
      const response = await fetch("/api/opening/study/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: attempt.sessionId, attemptId: attempt.id, clientKey, change }) });
      const raw: unknown = await response.json();
      if (!response.ok) { const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(raw); throw new Error(failure.success ? failure.data.error.message : "学习意图保存未确认，可用同一选择重试。"); }
      const result = resultSchema.parse(raw);
      if (result.currentVersion >= watermark.current) {
        watermark.current = result.currentVersion;
        setReceipt(result);
        setKnownEvent(result.currentEvent);
        if (!queuedPreference.current) {
          lastPreference.current = JSON.stringify(result.currentIntent);
          const action = result.event.version === result.currentVersion ? result.event.action : "continue";
          if (action !== "clarify_intent") onAppliedRef.current?.(result.currentIntent, action, result.event.version === result.currentVersion && result.event.signals.some(signal => signal === "guessed" || signal === "copied_answer") ? result.event.id : undefined);
        }
      }
      confirmed = true; unresolved.current = null; keys.current.delete(identity);
    } catch (reason) { unresolved.current = identity; setError(userFacingMessage(reason, "意图保存未确认")); }
    finally {
      busy.current = false; setPending(false);
      if (confirmed) {
        const queued = queuedPreference.current; queuedPreference.current = null;
        if (queued) void applyRef.current(queued);
      }
    }
  }, [attempt.id, attempt.sessionId]);
  applyRef.current = apply;
  useEffect(() => {
    if (!desiredIntent || desiredKey === lastPreference.current) return;
    lastPreference.current = desiredKey;
    void apply({ kind: "preference", intent: desiredIntent });
  }, [desiredIntent, desiredKey, apply]);
  return <section className="group/intent space-y-3" aria-label="调整本次学习">
    <button type="button" className={ui.quiet} aria-expanded={actionsOpen} onClick={() => setActionsOpen(value => !value)}>讲解帮助</button>
    <div className={actionsOpen ? "flex" : "hidden group-hover/intent:flex group-focus-within/intent:flex"}>
    <ExplanationActions availableActions={askExplanation ? undefined : ["confused", "faster", "deeper"]} disabled={pending || Boolean(unresolved.current)} onAction={action => {
      if (action === "example") { askExplanation?.(explanationActionPrompt(action)); return; }
      if (action === "confused") void apply({ kind: "signal", signal: "confused" });
      else void apply({ kind: "explicit_request", text: action === "faster" ? "快一点，直接给关键步骤" : "慢一点，完整讲解，一步一步等我" });
    }} /></div>
    <details><summary className="cursor-pointer text-xs text-text-2">调整讲解和练习</summary><div className="mt-3 space-y-3">
    <div className="flex flex-wrap gap-2">{([ ["too_easy", "太简单"], ["guessed", "我是猜的"], ["copied_answer", "这次参考了答案"] ] as const).map(([signal, label]) => <button key={signal} type="button" className={ui.quiet} disabled={pending || Boolean(unresolved.current)} onClick={() => void apply({ kind: "signal", signal })}>{label}</button>)}</div>
    </div></details>
    {pending ? <p role="status" className="text-xs text-text-3">正在调整学习安排…</p> : null}
    {receipt && receipt.event.version < receipt.currentVersion ? <p role="status" className="text-xs leading-6">上次的选择已恢复，接下来继续按你最新的选择学习。</p> : receipt ? <div role="status" className="space-y-1 text-xs leading-6"><p>{receipt.event.action === "diagnose" ? "放慢一点，先从一个小步骤开始。" : receipt.event.action === "increase_challenge" ? "接下来试一道更有挑战的新题。" : receipt.event.action === "clarify_intent" ? "你想快速串讲，还是挑战更难的题？" : "已保存你的学习偏好。"}</p><p>{receipt.move.presentation.instructions}</p><p>{receipt.move.studentAction}</p>{receipt.event.signals.includes("copied_answer") ? <p>已记下这次参考过答案，之后可以试着独立做一道新题。</p> : null}{receipt.event.action !== "clarify_intent" ? <Link className={ui.quiet} href={`/opening/courses/${attempt.courseId}/study/span?intentEvent=${receipt.event.id}&move=${receipt.move.id}`}>按这个安排继续</Link> : null}</div> : null}
    {diagnostics && knownEvent ? <details className="text-xs leading-6 text-text-3"><summary className="cursor-pointer">当前意图版本与依据</summary><p>版本 {knownEvent.version} · {knownEvent.intent.purpose} · {knownEvent.intent.pace} · {knownEvent.intent.timeBudgetMinutes} 分钟</p><p>记录时间 {knownEvent.createdAt}；新的意图事件会让旧意图版本的决策失效。</p></details> : null}
    {error ? <div role="alert" className="space-y-2 text-xs text-danger"><p>{error}</p>{lastChange.current ? <button type="button" disabled={pending} className={ui.secondary} onClick={() => { if (lastChange.current) void apply(lastChange.current); }}>重新确认同一次意图</button> : null}</div> : null}
  </section>;
}
