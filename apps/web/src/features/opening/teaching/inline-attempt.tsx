"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningObservation, TeachingActivity, TeachingAnswerKey } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { buildSelfCompareRevision, buildSelfJudgedRevision, referenceCheckFailure, selfCompareRevisionIntentKey } from "../learning/reference-check";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";
import { createTeachingActivityClient } from "./activity-client";
import { createInlineAttemptSubmission } from "./inline-attempt-submission";
import { createInlineAttemptDrafts, inlineAttemptIdentityKey, type InlineAttemptDraft } from "./inline-attempt-drafts";

export type InlineAttemptContext = Pick<TeachingActivity, "id" | "courseId" | "sourceIds" | "contentVersion" | "intentSummary" | "status"> & {
  onCourseAssociated: (activity: TeachingActivity) => void;
};

/** The reference is fetched only after the original answer is durably submitted. */
export function InlineAttempt({ blockId, prompt, context }: { blockId: string; prompt: string; context: InlineAttemptContext }) {
  const drafts = useRef(createInlineAttemptDrafts());
  const identity = inlineAttemptIdentityKey(context.id, blockId, context.contentVersion);
  const previous = drafts.current.previous(context.id, blockId, context.contentVersion);
  return <>
    <InlineAttemptForm key={identity} blockId={blockId} prompt={prompt} context={context} initialDraft={drafts.current.get(identity)} onDraftChange={(draft) => drafts.current.set(identity, draft)} />
    {previous.length ? <details className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600"><summary className="cursor-pointer">查看上一版未确认保存的草稿</summary>{previous.map(([key, draft]) => <div key={key} className="mt-2 space-y-1"><p>{draft.prompt}</p><p className="whitespace-pre-wrap">{draft.answer}</p></div>)}</details> : null}
  </>;
}

function InlineAttemptForm({ blockId, prompt, context, initialDraft, onDraftChange }: { blockId: string; prompt: string; context: InlineAttemptContext; initialDraft?: InlineAttemptDraft; onDraftChange: (draft: InlineAttemptDraft | null) => void }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const api = useMemo(() => createOpeningApi(), []);
  const teaching = useMemo(() => createTeachingActivityClient(), []);
  const [answer, setAnswer] = useState(initialDraft?.answer ?? "");
  const [skillLabel, setSkillLabel] = useState(initialDraft?.skillLabel ?? context.intentSummary.slice(0, 200));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recorded, setRecorded] = useState<LearningObservation | null>(null);
  const [answerKey, setAnswerKey] = useState<TeachingAnswerKey | null>(null);
  const [checked, setChecked] = useState(false);
  const [rereadNeeded, setRereadNeeded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [courseId, setCourseId] = useState("");
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const submission = useRef<ReturnType<typeof createInlineAttemptSubmission> | null>(null);
  const inFlight = useRef(false);
  const revision = useRef<{ intent: string; clientKey: string } | null>(null);

  useEffect(() => {
    if (context.courseId || context.status === "completed") return;
    let active = true;
    void client.listRevisionCourses().then((rows) => { if (active) setCourses(rows); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取课程"); });
    return () => { active = false; };
  }, [client, context.courseId, context.status]);

  async function bindCourse() {
    if (!courseId || inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const fresh = await api.getTeachingActivity(context.id);
      const activity = await api.associateTeachingActivityCourse(context.id, { courseId, expectedUpdatedAt: fresh.updatedAt });
      context.onCourseAssociated(activity);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "课程关联未确认，请重新读取活动。"); }
    finally { inFlight.current = false; setPending(false); }
  }

  async function readAnswer(id: string) {
    setAnswerKey(await teaching.getAnswerKey(context.id, blockId, id));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context.courseId || inFlight.current || context.status === "completed") return;
    inFlight.current = true; setPending(true); setError("");
    submission.current ??= createInlineAttemptSubmission({ activityId: context.id, courseId: context.courseId, blockId, contentVersion: context.contentVersion, sourceIds: context.sourceIds, prompt, skillLabel: skillLabel.trim(), answer }, client);
    try {
      const result = await submission.current.submit();
      onDraftChange(null);
      setRecorded(result.observation); setAttemptId(result.attemptId);
      await readAnswer(result.attemptId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "答案保存未确认，可用相同请求重新确认。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  async function compare(choice: "match" | "mismatch") {
    if (!recorded || !answerKey?.answer || inFlight.current || checked || rereadNeeded) return;
    const referenceSourceId = answerKey.referenceSourceId;
    const intent = selfCompareRevisionIntentKey(recorded.id, choice, null) + (referenceSourceId ? "" : ":self");
    if (revision.current?.intent !== intent) revision.current = { intent, clientKey: `teaching-compare:${crypto.randomUUID()}` };
    // Without a material behind the key the judgment stays a self-report.
    const input = referenceSourceId
      ? buildSelfCompareRevision({ observation: recorded, referenceSourceId, choice, clientKey: revision.current.clientKey })
      : buildSelfJudgedRevision({ observation: recorded, choice, clientKey: revision.current.clientKey });
    if (!input) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const result = await client.reviseObservation(input);
      if (result.observation) setRecorded(result.observation);
      setChecked(true);
    } catch (reason) {
      const failure = referenceCheckFailure(reason);
      setError(failure.message); setRereadNeeded(true);
      if (failure.kind === "unavailable") setUnavailable(true);
    }
    finally { inFlight.current = false; setPending(false); }
  }
  async function rereadComparison() {
    if (!recorded || inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const history = await client.getObservationHistory(recorded.id);
      const head = history.revisions.find((row) => row.id === history.headObservationId);
      if (!head || head.revisionKind === "retract") { setUnavailable(true); setError("这条作答记录已撤回，无法继续核对。"); return; }
      setRecorded(head); setChecked(head.verdictSource === "reference_checked");
      setRereadNeeded(false); revision.current = null;
    } catch (reason) {
      const failure = referenceCheckFailure(reason); setError(failure.message);
      if (failure.kind === "unavailable") setUnavailable(true);
    } finally { inFlight.current = false; setPending(false); }
  }

  if (unavailable) return <p role="alert" className="mt-3 text-xs text-red-700">{error || "本条作答记录已不可用，请重新读取活动。"}</p>;
  return <div className="mt-3 space-y-3 border-t border-amber-200/70 pt-3" data-inline-attempt={blockId}>
    {!context.courseId && context.status !== "completed" ? <div className="space-y-2">
      <p className="text-xs text-zinc-600">先关联课程，作答才能保存到对应的学习记录。</p>
      <label className="block text-xs text-zinc-700">学习记录所属课程<select className="mt-1 block w-full rounded-md border border-zinc-200 bg-white px-2 py-2" value={courseId} disabled={pending} onChange={(event) => setCourseId(event.target.value)}><option value="">选择已有课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
      <button type="button" className={ui.secondary} disabled={!courseId || pending} onClick={() => { void bindCourse(); }}>关联此课程</button>
      {!courses.length ? <p className="text-xs text-zinc-500">可先到课程页创建课程，再返回作答。</p> : null}
    </div> : null}
    {!recorded ? <form className="space-y-2" onSubmit={(event) => { void submit(event); }}>
      <label className="block text-xs text-zinc-700">记录的技能<input className="mt-1 block w-full rounded-md border border-zinc-200 bg-white px-2 py-2" value={skillLabel} maxLength={200} disabled={pending || Boolean(submission.current)} onChange={(event) => { setSkillLabel(event.target.value); onDraftChange({ answer, skillLabel: event.target.value, prompt }); }} /></label>
      <label className="block text-xs text-zinc-700">我的原答案<textarea className="mt-1 min-h-24 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm" value={answer} maxLength={20_000} disabled={pending || Boolean(submission.current) || context.status === "completed"} onChange={(event) => { setAnswer(event.target.value); onDraftChange({ answer: event.target.value, skillLabel, prompt }); }} /></label>
      <button type="submit" className={ui.primary} disabled={pending || !context.courseId || !skillLabel.trim() || !answer.trim() || context.status === "completed"}>{pending ? "正在保存…" : submission.current ? "重新确认原答案已保存" : "提交原答案，再看参考"}</button>
    </form> : <div className="space-y-2">
      <p className="text-xs font-medium text-zinc-700">原答案已保存</p><p className="whitespace-pre-wrap text-sm text-zinc-800">{recorded.answer}</p>
      {answerKey ? <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-900/5"><p className="mb-2 text-xs font-medium text-zinc-600">参考答案 · 请自行核对</p>{answerKey.answer ? <LearningProse text={answerKey.answer} /> : <p className="text-xs text-zinc-500">这道题没有配套的参考答案，已保留未核对记录；可以去自由对话请 AI 老师讲解。</p>}</div> : <button type="button" className={ui.secondary} disabled={pending || !attemptId} onClick={() => { if (attemptId) void readAnswer(attemptId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取参考答案")); }}>重新读取参考答案</button>}
      {!checked && !rereadNeeded && answerKey?.answer ? <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={pending} onClick={() => { void compare("match"); }}>我答对了</button><button type="button" className={ui.secondary} disabled={pending} onClick={() => { void compare("mismatch"); }}>我答错了</button><button type="button" className={ui.quiet} disabled={pending} onClick={() => setChecked(true)}>暂不核对，保留未核对记录</button></div> : null}
      {rereadNeeded ? <button type="button" className={ui.secondary} disabled={pending} onClick={() => { void rereadComparison(); }}>重新读取核对记录</button> : null}
      {answerKey?.answer && !answerKey.referenceSourceId && !checked ? <p className="text-xs text-zinc-600">这份参考答案由 AI 老师给出、没有关联材料：你的判断按自评记录，可用于复习安排，但不计入独立掌握证据。</p> : null}
      {checked ? <p role="status" className="text-xs text-zinc-600">{recorded.outcome === "correct" ? (recorded.verdictSource === "reference_checked" ? "已记录你对照参考后的正确判断。" : "已按自评记录为答对。") : recorded.outcome === "incorrect" ? "已记录这题需要复查。" : "已保留未核对记录。"}</p> : null}
    </div>}
    {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
  </div>;
}
