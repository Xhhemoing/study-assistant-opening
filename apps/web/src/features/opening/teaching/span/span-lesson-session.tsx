"use client";
import { TransitionLink as Link } from "../../v3/motion/view-transition";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spanLessonSnapshotSchema, type SpanLessonSnapshot, type StudySessionIntent } from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT, spanModeForIntent } from "@aistudy/domain";
import { ui } from "../../design/ui";
import { SpanLesson } from "./span-lesson";
import { spanLessonDetailsSchema, spanLessonRequest, type SpanLessonDetails } from "./span-session-client";
import { SpanSessionSummary } from "./span-session-summary";
import { userFacingMessage } from "../../../../lib/user-facing-error";
import { SpanNextActionControl } from "./span-next-action-control";
import { spanProblemText } from "./span-problem-text";
import { isSpanReservedProblemId } from "./span-answer";

import { useOpeningCapabilities } from "../../capabilities/capabilities-provider";
import { createSpanStudySession } from "../../study-session/adapters/span";
import { StudySession } from "../../study-session/study-session-shell";

type Props = { originalConversationId?: string | null; courseId: string; sourceIds: string[]; sourceLoadError: boolean; delayedRetestId?: string; initialIntent?: StudySessionIntent; initialMoveId?: string; initialNewEvidenceEventId?: string; initialActivityId?: string };
const endpoint = "/api/opening/teaching/span/lesson";
/** Superseded activities remain readable without mounting question/help writers. */
function SpanOriginChangeView({ details, courseId, onReload }: { details: SpanLessonDetails; courseId: string; onReload: () => void }) {
  const [history, setHistory] = useState(false);
  const change = details.originChange!;
  const origin = change.originSession?.courseId === courseId ? change.originSession : null;
  if (history) return <section className="mx-auto max-w-4xl space-y-4 p-5" aria-label="原活动只读历史">
    <h1 className="text-lg font-semibold">原活动历史 · 只读</h1>
    <p className="text-sm leading-7 text-text-2">保留原题与作答记录。本页不会发放新题、请求帮助或改变原活动。</p>
    <div className="space-y-3"><h2 className="text-sm font-semibold">原练习</h2>{details.attempts.length ? details.attempts.map((attempt, index) => <article key={attempt.id} className="rounded-lg border border-line p-3"><h3 className="text-sm font-medium">练习 {index + 1}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-7">{attempt.spanExercise ? spanProblemText(attempt.spanExercise).chinese : "原题暂不可读，作答记录仍保留。"}</p></article>) : <p className="text-sm text-text-2">没有可读取的原题记录。</p>}</div>
    <div className="space-y-3"><h2 className="text-sm font-semibold">原作答记录</h2>{details.observations.length ? details.observations.map((row, index) => <article key={row.id} className="rounded-lg border border-line p-3"><h3 className="text-sm font-medium">{row.skillLabel || `作答 ${index + 1}`}</h3><pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{row.answer}</pre></article>) : <p className="text-sm text-text-2">没有已保存的作答。</p>}</div>
    <button type="button" className={ui.secondary} onClick={() => setHistory(false)}>返回重新选择</button>
    <Link className={ui.quiet} href={`/opening/courses/${courseId}#course-learning-records`}>查看课程记录</Link>
  </section>;
  return <section className="mx-auto max-w-4xl space-y-4 p-5" aria-label="原学习依据已变化">
    <h1 className="text-lg font-semibold">先核对这次学习安排</h1>
    <p role="status" className="text-sm leading-7 text-warn">{change.reason === "evidence_changed" ? "原评价已变化，先前由它派生的纠偏活动暂不继续。原活动与答案保留，请根据最新记录重新选择。" : "原题或材料目前不可用，先前的纠偏活动暂不继续。请先恢复或核对课程材料，原记录仍保留。"}</p>
    {change.reason === "evidence_changed" && origin ? <SpanNextActionControl session={origin} observationId={change.observationId} onReload={onReload} /> : <Link className={ui.primary} href={`/opening/courses/${courseId}`}>核对课程与材料</Link>}
    <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} onClick={() => setHistory(true)}>查看原活动历史</button><Link className={ui.quiet} href={`/opening/courses/${courseId}#course-learning-records`}>查看课程记录</Link><button type="button" className={ui.quiet} onClick={onReload}>重新读取当前依据</button></div>
  </section>;
}
export function SpanLessonSession(props: Props) {
  const [details, setDetails] = useState<SpanLessonDetails | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const [revision, setRevision] = useState(0);
  const [readVersion, setReadVersion] = useState(0);
  const activityId = useRef(props.initialActivityId);
  const requestId = useRef(0), busy = useRef(false);
  const createKey = useRef<string | null>(null);
  const autoStarted = useRef(false);
  const recoveryReady = useRef(false);
  const readRoute = useRef({ courseId: props.courseId, retestId: props.delayedRetestId, activityId: props.initialActivityId, revision });
  const query = useCallback(() => {
    const params = new URLSearchParams({ courseId: props.courseId });
    if (activityId.current) params.set("activityId", activityId.current);
    if (props.delayedRetestId) params.set("retestId", props.delayedRetestId);
    return `${endpoint}?${params}`;
  }, [props.courseId, props.delayedRetestId]);
  useEffect(() => () => { requestId.current++; }, []);
  useEffect(() => {
    const previous = readRoute.current;
    const scopeChanged = previous.courseId !== props.courseId || previous.retestId !== props.delayedRetestId;
    const activityChanged = previous.activityId !== props.initialActivityId;
    readRoute.current = { courseId: props.courseId, retestId: props.delayedRetestId, activityId: props.initialActivityId, revision };
    // replaceState may expose the activity we just acknowledged to route props.
    // Adopting that same receipt must not remount a learner's editing tree.
    if (!scopeChanged && activityChanged && props.initialActivityId === activityId.current && previous.revision === revision) return;
    if (scopeChanged || activityChanged) {
      activityId.current = props.initialActivityId;
      autoStarted.current = false;
      createKey.current = null; busy.current = false;
      setDetails(null); setShowSummary(false); setPending(false);
    }
    const version = ++requestId.current;
    recoveryReady.current = false;
    setError("");
    void spanLessonRequest(query(), spanLessonDetailsSchema).then(value => {
      if (version === requestId.current) { recoveryReady.current = true; setDetails(value); setReadVersion(current => current + 1); if (value.session) activityId.current = value.session.activityId; }
    }).catch(reason => { if (version === requestId.current) setError(userFacingMessage(reason, "无法恢复本次学习。")); });
  }, [query, revision, props.initialActivityId]);
  useEffect(() => {
    if (!recoveryReady.current || !details || details.originChange || details.session || error || props.sourceLoadError || !props.sourceIds.length || autoStarted.current) return;
    autoStarted.current = true;
    void start();
  }, [details, error, props.sourceLoadError, props.sourceIds]);
  function remember(value: SpanLessonSnapshot) {
    activityId.current = value.activityId;
    const url = new URL(window.location.href); url.searchParams.set("lesson", value.activityId);
    window.history.replaceState(window.history.state, "", url);
  }
  async function start() {
    if (details?.originChange || busy.current) return;
    busy.current = true; const version = ++requestId.current; setPending(true); setError("");
    try {
      createKey.current ??= `span-lesson:${crypto.randomUUID()}`;
      let session = await spanLessonRequest(endpoint, spanLessonSnapshotSchema, { method: "POST", body: JSON.stringify({ courseId: props.courseId, sourceIds: props.sourceIds,
        intent: props.initialIntent ?? DEFAULT_STUDY_SESSION_INTENT, clientKey: createKey.current, ...(props.delayedRetestId ? { retestId: props.delayedRetestId } : {}) }) });
      if (version !== requestId.current) return;
      remember(session);
      const moveId = props.initialNewEvidenceEventId ? `${spanModeForIntent(session.intent)}-reserved` : props.initialMoveId;
      if (moveId && moveId !== session.moveId) session = await spanLessonRequest(`${endpoint}?activityId=${session.activityId}`, spanLessonSnapshotSchema,
        { method: "PATCH", body: JSON.stringify({ expectedRevision: session.revision, intent: session.intent, moveId, status: "active" }) });
      if (version !== requestId.current) return;
      remember(session); setDetails({ session, attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null });
    } catch (reason) { if (version === requestId.current) setError(userFacingMessage(reason, "学习暂未开始。")); }
    finally { if (version === requestId.current) { busy.current = false; setPending(false); } }
  }
  async function save(intent: StudySessionIntent, moveId: string, status: "active" | "paused" | "completed") {
    const current = details?.session;
    if (!current || details?.originChange || busy.current) return false;
    busy.current = true; const version = ++requestId.current; setPending(true); setError("");
    try {
      const session = await spanLessonRequest(`${endpoint}?activityId=${current.activityId}`, spanLessonSnapshotSchema, { method: "PATCH", body: JSON.stringify({ expectedRevision: current.revision, intent, moveId, status }) });
      if (version !== requestId.current) return false;
      remember(session); setDetails(value => value ? { ...value, session } : value);
      // The PATCH response is the authoritative paused/completed snapshot. A
      // follow-up GET here can race the just-finished write and briefly restore
      // the active view, so only active step changes need a recovery reload.
      if (status !== "active") setShowSummary(true);
      return true;
    } catch (reason) { if (version === requestId.current) setError(userFacingMessage(reason, "进度保存未确认。")); return false; }
    finally { if (version === requestId.current) { busy.current = false; setPending(false); } }
  }
  const { studySessionV2, studySessionV2PhotoAnswer } = useOpeningCapabilities();
  const v2Port = useMemo(() => studySessionV2 && details?.session && !details.originChange && !props.delayedRetestId
    ? createSpanStudySession(details, save, { photoEnabled: studySessionV2PhotoAnswer }) : null, [studySessionV2, studySessionV2PhotoAnswer, details, props.delayedRetestId]);
  const session = details?.session;
  const evidenceEvent = details?.intentEvent?.signals.some(signal => signal === "guessed" || signal === "copied_answer") ? details.intentEvent : null;
  const restoredAttempts = details?.attempts.filter(attempt => !isSpanReservedProblemId(attempt.spanExercise?.id) ||
    (evidenceEvent ? attempt.startedAt >= evidenceEvent.createdAt : !props.initialNewEvidenceEventId)) ?? [];
  return <div className="h-full min-h-0 min-w-0 text-text">
    {error ? <div role="alert" className="m-4 space-y-2 rounded-lg border border-danger p-3 text-sm"><p>{error}</p><button type="button" className={ui.secondary} disabled={pending} onClick={() => setRevision(value => value + 1)}>继续加载</button></div> : null}
    {!details ? <p role="status" className="p-5 text-sm text-text-2">正在准备这节课…</p> : details.originChange ? <SpanOriginChangeView key={`${props.courseId}:${readVersion}`} details={details} courseId={props.courseId} onReload={() => setRevision(value => value + 1)} /> : !session ? <section className="mx-auto max-w-3xl space-y-4 p-5"><h1 className="text-xl font-semibold">线性组合与 span</h1><p className="text-sm leading-7">目标：建立向量等式，求系数并检查所有坐标。</p><p className="text-sm text-text-2">约 {props.initialIntent?.timeBudgetMinutes ?? 20} 分钟；进入后可随时调整或暂停。</p><button type="button" className={ui.primary} disabled={pending || props.sourceLoadError || !props.sourceIds.length} onClick={() => void start()}>{pending ? "正在开始…" : props.delayedRetestId ? "开始本次延迟复测" : "开始本次学习"}</button>{props.sourceLoadError || !props.sourceIds.length ? <p className="text-sm text-warn">请先关联一份可用课程材料，再开始正式学习。</p> : null}<Link className={ui.quiet} href={`/opening/courses/${props.courseId}/study`}>返回课程</Link></section> : <>
      {session.status === "active" ? v2Port ? <StudySession port={v2Port} /> : <SpanLesson key={`${session.activityId}:${readVersion}`} {...props} sourceIds={session.sourceIds} session={session} initialIntent={session.intent} initialMoveId={session.moveId} initialNewEvidenceEventId={evidenceEvent?.id ?? props.initialNewEvidenceEventId}
        executionPhase={details.executionPhase ?? undefined} restoredAttempts={restoredAttempts} restoredObservations={details.observations} restoredHintLevels={details.hintLevels} onProgress={save} savingProgress={pending} onReload={() => setRevision(value => value + 1)}
        onSummary={() => { setShowSummary(true); setRevision(value => value + 1); }} /> : <div className="mx-auto max-w-4xl space-y-3 p-5"><h1 className="text-xl font-semibold">{session.status === "paused" ? "本次学习已暂停" : "本次学习已结束"}</h1><p className="text-sm text-text-2">下次可以接着这里学。</p><div className="flex flex-wrap gap-2">{session.status === "paused" ? <button className={ui.primary} disabled={pending} onClick={() => void save(session.intent, session.moveId, "active")}>继续原来的步骤</button> : <Link className={ui.primary} href="/opening/today">回到今日，看下一步</Link>}<Link className={ui.quiet} href={`/opening/courses/${props.courseId}`}>返回课程</Link></div></div>}
      {showSummary || session.status !== "active" ? <div className="mx-auto max-w-4xl px-5 pb-8"><SpanSessionSummary key={`${session.activityId}:${readVersion}`} session={session} observations={details.observations} delayed={Boolean(props.delayedRetestId)} onReload={() => setRevision(value => value + 1)} /></div> : null}
    </>}
  </div>;
}
