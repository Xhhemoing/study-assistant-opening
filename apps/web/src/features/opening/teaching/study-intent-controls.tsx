"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { studyIntentEventSchema, studySessionIntentSchema, type LearningAttempt, type StudyIntentChange, type StudyIntentEvent, type StudySessionIntent } from "@aistudy/contracts";
import { ui } from "../design/ui";
const resultSchema = z.object({ event: studyIntentEventSchema, currentEvent: studyIntentEventSchema, currentIntent: studySessionIntentSchema, currentVersion: z.number().int().positive(),
  move: z.object({ id: z.string(), presentation: z.object({ instructions: z.string() }), studentAction: z.string() }) });
export function StudyIntentControls({ attempt, desiredIntent, onApplied }: { attempt: LearningAttempt; desiredIntent?: StudySessionIntent;
  onApplied?: (intent: StudySessionIntent, action: StudyIntentEvent["action"], newEvidenceEventId?: string) => void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
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
      if (!controller.signal.aborted && mutation.current === 0 && result.event && result.event.version >= watermark.current) { watermark.current = result.event.version; setKnownEvent(result.event); lastPreference.current = JSON.stringify(result.event.intent); onAppliedRef.current?.(result.event.intent, "continue"); }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "意图暂不可读取"); });
    return () => controller.abort();
  }, [attempt.sessionId]);
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
    } catch (reason) { unresolved.current = identity; setError(reason instanceof Error ? reason.message : "意图保存未确认"); }
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
  return <section className="space-y-3 rounded-lg border border-line p-3" aria-label="调整本次学习">
    <p className="text-xs leading-6 text-text-2">直接说明需要什么；只改变教学安排与本次作答条件，不直接上调或下调能力。</p>
    <div className="flex flex-wrap gap-2">{([ ["confused", "我不懂"], ["too_easy", "太简单"], ["guessed", "我是猜的"], ["copied_answer", "这次抄了答案"] ] as const).map(([signal, label]) => <button key={signal} type="button" className={ui.quiet} disabled={pending || Boolean(unresolved.current)} onClick={() => void apply({ kind: "signal", signal })}>{label}</button>)}</div>
    <div className="flex flex-wrap gap-2">{["快速串讲", "直接给关键步骤", "一步一步等我"].map(text => <button type="button" key={text} className={ui.secondary} disabled={pending || Boolean(unresolved.current)} onClick={() => void apply({ kind: "explicit_request", text })}>{text}</button>)}</div>
    {pending ? <p role="status" className="text-xs text-text-3">正在保存意图版本与下一步原因…</p> : null}
    {receipt && receipt.event.version < receipt.currentVersion ? <p role="status" className="text-xs leading-6">已恢复历史请求；当前意图保持最新版本，不重新执行历史教学动作。</p> : receipt ? <div role="status" className="space-y-1 text-xs leading-6"><p>{receipt.event.action === "diagnose" ? "已放慢节奏，先回到关系与小步骤诊断。" : receipt.event.action === "increase_challenge" ? "已转入预设迁移挑战；需要新题表现后才判断效果。" : receipt.event.action === "clarify_intent" ? "这条目的有实质歧义，请明确选择串讲或拔高。" : "学习意图已保存，本次正确性记录保持不变。"}</p><p>{receipt.move.presentation.instructions}</p><p>{receipt.move.studentAction}</p>{receipt.event.signals.includes("copied_answer") ? <p>本次已报告看过答案，会限制独立证据；不会把答对直接改成答错。</p> : null}{receipt.event.action !== "clarify_intent" ? <Link className={ui.quiet} href={`/opening/courses/${attempt.courseId}/study/span?intentEvent=${receipt.event.id}&move=${receipt.move.id}`}>打开对应教学动作</Link> : null}</div> : null}
    {knownEvent ? <details className="text-xs leading-6 text-text-3"><summary className="cursor-pointer">当前意图版本与依据</summary><p>版本 {knownEvent.version} · {knownEvent.intent.purpose} · {knownEvent.intent.pace} · {knownEvent.intent.timeBudgetMinutes} 分钟</p><p>记录时间 {knownEvent.createdAt}；新的意图事件会让旧意图版本的决策失效。</p></details> : null}
    {error ? <div role="alert" className="space-y-2 text-xs text-danger"><p>{error}</p>{lastChange.current ? <button type="button" disabled={pending} className={ui.secondary} onClick={() => { if (lastChange.current) void apply(lastChange.current); }}>重新确认同一次意图</button> : null}</div> : null}
  </section>;
}
