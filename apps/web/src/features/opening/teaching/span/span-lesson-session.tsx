"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { spanLessonSnapshotSchema, type SpanLessonSnapshot, type StudySessionIntent } from "@aistudy/contracts";
import { DEFAULT_STUDY_SESSION_INTENT, spanModeForIntent } from "@aistudy/domain";
import { ui } from "../../design/ui";
import { SpanLesson } from "./span-lesson";
import { spanLessonDetailsSchema, spanLessonRequest, type SpanLessonDetails } from "./span-session-client";
import { SpanSessionSummary } from "./span-session-summary";

type Props = { courseId: string; sourceIds: string[]; sourceLoadError: boolean; delayedRetestId?: string; initialIntent?: StudySessionIntent; initialMoveId?: string; initialNewEvidenceEventId?: string; initialActivityId?: string };
const endpoint = "/api/opening/teaching/span/lesson";
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
    setError("");
    void spanLessonRequest(query(), spanLessonDetailsSchema).then(value => {
      if (version === requestId.current) { setDetails(value); setReadVersion(current => current + 1); if (value.session) activityId.current = value.session.activityId; }
    }).catch(reason => { if (version === requestId.current) setError(reason instanceof Error ? reason.message : "无法恢复本次学习。"); });
  }, [query, revision, props.initialActivityId]);
  useEffect(() => {
    if (!details || details.session || error || props.sourceLoadError || !props.sourceIds.length || autoStarted.current) return;
    autoStarted.current = true;
    void start();
  }, [details, error, props.sourceLoadError, props.sourceIds]);
  function remember(value: SpanLessonSnapshot) {
    activityId.current = value.activityId;
    const url = new URL(window.location.href); url.searchParams.set("lesson", value.activityId);
    window.history.replaceState(window.history.state, "", url);
  }
  async function start() {
    if (busy.current) return;
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
    } catch (reason) { if (version === requestId.current) setError(reason instanceof Error ? reason.message : "学习暂未开始。"); }
    finally { if (version === requestId.current) { busy.current = false; setPending(false); } }
  }
  async function save(intent: StudySessionIntent, moveId: string, status: "active" | "paused" | "completed") {
    const current = details?.session;
    if (!current || busy.current) return false;
    busy.current = true; const version = ++requestId.current; setPending(true); setError("");
    try {
      const session = await spanLessonRequest(`${endpoint}?activityId=${current.activityId}`, spanLessonSnapshotSchema, { method: "PATCH", body: JSON.stringify({ expectedRevision: current.revision, intent, moveId, status }) });
      if (version !== requestId.current) return false;
      remember(session); setDetails(value => value ? { ...value, session } : value);
      if (status !== "active") { setShowSummary(true); setRevision(value => value + 1); }
      return true;
    } catch (reason) { if (version === requestId.current) setError(reason instanceof Error ? reason.message : "进度保存未确认。"); return false; }
    finally { if (version === requestId.current) { busy.current = false; setPending(false); } }
  }
  const session = details?.session;
  const evidenceEvent = details?.intentEvent?.signals.some(signal => signal === "guessed" || signal === "copied_answer") ? details.intentEvent : null;
  const restoredAttempts = details?.attempts.filter(attempt => !attempt.spanExercise?.id.startsWith("span-reserved-") ||
    (evidenceEvent ? attempt.startedAt >= evidenceEvent.createdAt : !props.initialNewEvidenceEventId)) ?? [];
  return <div className="h-full min-h-0 min-w-0 text-text">
    {error ? <div role="alert" className="m-4 space-y-2 rounded-lg border border-danger p-3 text-sm"><p>{error}</p><button type="button" className={ui.secondary} disabled={pending} onClick={() => setRevision(value => value + 1)}>继续加载</button></div> : null}
    {!details ? <p role="status" className="p-5 text-sm text-text-2">正在准备这节课…</p> : !session ? <section className="mx-auto max-w-3xl space-y-4 p-5"><h1 className="text-xl font-semibold">线性组合与 span</h1><p className="text-sm leading-7">目标：建立向量等式，求系数并检查所有坐标。</p><p className="text-sm text-text-2">约 {props.initialIntent?.timeBudgetMinutes ?? 20} 分钟；进入后可随时调整或暂停。</p><button type="button" className={ui.primary} disabled={pending || props.sourceLoadError || !props.sourceIds.length} onClick={() => void start()}>{pending ? "正在开始…" : props.delayedRetestId ? "开始本次延迟复测" : "开始本次学习"}</button>{props.sourceLoadError || !props.sourceIds.length ? <p className="text-sm text-warn">请先关联一份可用课程材料，再开始正式学习。</p> : null}<Link className={ui.quiet} href={`/opening/courses/${props.courseId}/study`}>返回课程</Link></section> : <>
      {session.status === "active" ? <SpanLesson key={`${session.activityId}:${readVersion}`} {...props} sourceIds={session.sourceIds} session={session} initialIntent={session.intent} initialMoveId={session.moveId} initialNewEvidenceEventId={evidenceEvent?.id ?? props.initialNewEvidenceEventId}
        restoredAttempts={restoredAttempts} restoredObservations={details.observations} restoredHintLevels={details.hintLevels} onProgress={save} savingProgress={pending}
        onSummary={() => { setShowSummary(true); setRevision(value => value + 1); }} /> : <div className="mx-auto max-w-4xl space-y-3 p-5"><h1 className="text-xl font-semibold">{session.status === "paused" ? "本次学习已暂停" : "本次学习已结束"}</h1><p className="text-sm text-text-2">下次可以接着这里学。</p>{session.status === "paused" ? <button className={ui.primary} disabled={pending} onClick={() => void save(session.intent, session.moveId, "active")}>继续原来的步骤</button> : null}<Link className={ui.quiet} href={`/opening/courses/${props.courseId}/study`}>返回课程</Link></div>}
      {showSummary || session.status !== "active" ? <div className="mx-auto max-w-4xl px-5 pb-8"><SpanSessionSummary observations={details.observations} delayed={Boolean(props.delayedRetestId)} /></div> : null}
    </>}
  </div>;
}
