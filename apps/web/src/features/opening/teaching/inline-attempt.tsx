"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningObservation, TeachingActivity, TeachingAnswerKey } from "@aistudy/contracts";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { buildSelfCompareRevision, referenceCheckFailure, selfCompareRevisionIntentKey } from "../learning/reference-check";
import { collectSkillLabelOptions, findSkillLabelReuseHint } from "../learning/skill-label-options";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";
import { createTeachingActivityClient } from "./activity-client";
import { createInlineAttemptSubmission, readInlineAttemptObservationHead, type InlineAttemptSubmissionCheckpoint } from "./inline-attempt-submission";
import { createInlineAttemptDrafts, inlineAttemptDraftConflict, inlineAttemptIdentityKey, type InlineAttemptDraft } from "./inline-attempt-drafts";
import { defaultInlineAttemptSkill } from "./inline-attempt-skill";

export type InlineAttemptContext = Pick<TeachingActivity, "id" | "courseId" | "sourceIds" | "contentVersion" | "intentSummary" | "status"> & {
  learnerFocus?: TeachingActivity["learnerFocus"];
  outlineTitle?: string;
  onCourseAssociated: (activity: TeachingActivity) => void;
};

/** The reference is fetched only after the original answer is durably submitted. */
export function InlineAttempt({ blockId, prompt, context }: { blockId: string; prompt: string; context: InlineAttemptContext }) {
  const drafts = useRef<ReturnType<typeof createInlineAttemptDrafts> | null>(null);
  const identity = inlineAttemptIdentityKey(context.id, blockId, context.contentVersion);
  const [restored, setRestored] = useState<{ identity: string; draft?: InlineAttemptDraft; previous: ReadonlyArray<readonly [string, InlineAttemptDraft]>; unavailable: boolean } | null>(null);
  useEffect(() => {
    drafts.current ??= createInlineAttemptDrafts();
    const draft = drafts.current.get(identity);
    const previous = drafts.current.previous(context.id, blockId, context.contentVersion);
    setRestored({ identity, draft, previous, unavailable: drafts.current.unavailable });
  }, [identity, context.id, blockId, context.contentVersion]);
  const ready = restored?.identity === identity;
  const previous = ready ? restored.previous : [];
  function saveDraft(draft: InlineAttemptDraft | null) {
    drafts.current?.set(identity, draft);
    setRestored(value => value?.identity === identity ? { ...value, draft: draft ?? undefined, unavailable: Boolean(drafts.current?.unavailable) } : value);
  }
  return <>
    <InlineAttemptForm key={`${identity}:${ready}`} blockId={blockId} prompt={prompt} context={context} ready={ready} initialDraft={ready ? restored.draft : undefined} onDraftChange={saveDraft} />
    {!ready ? <p role="status" className="mt-2 text-xs text-zinc-500">正在恢复本标签页的作答草稿…</p> : null}
    {ready && restored.unavailable ? <p role="status" className="mt-2 text-xs text-amber-800">浏览器无法保存草稿；本页内跳转仍会保留，刷新或关闭页面后会丢失。请先复制答案。</p> : null}
    {previous.length ? <details className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600"><summary className="cursor-pointer">查看上一版未确认保存的草稿</summary>{previous.map(([key, draft]) => <div key={key} className="mt-2 space-y-1"><p>{draft.prompt}</p><p className="whitespace-pre-wrap">{draft.answer}</p>{draft.submission ? <p>此版已发起提交，保存结果请到学习记录确认。</p> : null}</div>)}</details> : null}
  </>;
}

function submissionDraft(checkpoint: InlineAttemptSubmissionCheckpoint): InlineAttemptDraft {
  return { answer: checkpoint.input.answer, skillLabel: checkpoint.input.skillLabel, prompt: checkpoint.input.prompt, submission: checkpoint };
}

function InlineAttemptForm({ blockId, prompt, context, ready, initialDraft, onDraftChange }: { blockId: string; prompt: string; context: InlineAttemptContext; ready: boolean; initialDraft?: InlineAttemptDraft; onDraftChange: (draft: InlineAttemptDraft | null) => void }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const api = useMemo(() => createOpeningApi(), []);
  const teaching = useMemo(() => createTeachingActivityClient(), []);
  const draftConflict = inlineAttemptDraftConflict(initialDraft, { courseId: context.courseId, prompt });
  const currentScope = useRef({ courseId: context.courseId, prompt });
  currentScope.current = { courseId: context.courseId, prompt };
  const [answer, setAnswer] = useState(initialDraft?.answer ?? "");
  const [skillLabel, setSkillLabel] = useState(() => defaultInlineAttemptSkill({
    draftSkillLabel: initialDraft?.skillLabel, learnerSkillLabel: context.learnerFocus?.skillLabel, outlineTitle: context.outlineTitle,
  }));
  // Delayed optional reads must never replace an edited (including cleared) skill.
  const skillEdited = useRef(initialDraft !== undefined);
  const [skillOptions, setSkillOptions] = useState<string[]>([]);
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
  if (!submission.current && initialDraft?.submission) submission.current = createInlineAttemptSubmission(initialDraft.submission.input, client, {
    checkpoint: initialDraft.submission, onCheckpoint: checkpoint => onDraftChange(submissionDraft(checkpoint)),
  });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const inFlight = useRef(false);
  const revision = useRef<{ intent: string; clientKey: string } | null>(null);

  useEffect(() => {
    if (!ready || context.courseId || context.status === "completed") return;
    let active = true;
    void client.listRevisionCourses().then((rows) => { if (active) setCourses(rows); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取课程"); });
    return () => { active = false; };
  }, [client, ready, context.courseId, context.status]);

  useEffect(() => {
    if (!ready || !context.courseId || context.status === "completed") return;
    let active = true;
    void Promise.all([
      client.getSummary(context.courseId).then(collectSkillLabelOptions).catch(() => [] as string[]),
      api.getCourseKnowledge(context.courseId).then(value => value.snapshot).catch(() => null),
    ]).then(([options, knowledge]) => {
      if (!active) return;
      setSkillOptions(options);
      if (!skillEdited.current && !submission.current) setSkillLabel(defaultInlineAttemptSkill({
        learnerSkillLabel: context.learnerFocus?.skillLabel, outlineTitle: context.outlineTitle,
        skillOptions: options, knowledge,
      }));
    });
    return () => { active = false; };
  }, [api, client, ready, context.courseId, context.status, context.learnerFocus?.skillLabel, context.outlineTitle]);

  const skillReuseHint = findSkillLabelReuseHint(skillLabel, skillOptions);
  const skillListId = useId();

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
    if (!ready || draftConflict || !context.courseId || inFlight.current || context.status === "completed") return;
    inFlight.current = true; setPending(true); setError("");
    submission.current ??= createInlineAttemptSubmission({ activityId: context.id, courseId: context.courseId, blockId, contentVersion: context.contentVersion, sourceIds: context.sourceIds, prompt, skillLabel: skillLabel.trim(), answer }, client, { onCheckpoint: checkpoint => onDraftChange(submissionDraft(checkpoint)) });
    try {
      const result = await submission.current.submit();
      if (!mounted.current || currentScope.current.courseId !== context.courseId || currentScope.current.prompt !== prompt) return;
      const observation = initialDraft?.submission ? await readInlineAttemptObservationHead(result.observation.id, client) : result.observation;
      if (!mounted.current || currentScope.current.courseId !== context.courseId || currentScope.current.prompt !== prompt) return;
      if (!observation) { setUnavailable(true); setError("这条作答记录已撤回，无法继续核对。"); return; }
      setRecorded(observation); setAttemptId(result.attemptId); setChecked(Boolean(observation.referenceCheck));
      await readAnswer(result.attemptId);
    } catch (reason) { setError(reason instanceof OpeningApiError && reason.status === 409 ? "学习内容或记录已更新，原答案和提交请求已保留。请重新读取活动或原课程学习记录后再确认。" : reason instanceof Error ? reason.message : "答案保存未确认，可用相同请求重新确认。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  async function compare(choice: "match" | "mismatch") {
    if (!recorded || !answerKey?.referenceSourceId || inFlight.current || checked || rereadNeeded) return;
    const intent = selfCompareRevisionIntentKey(recorded.id, choice, null);
    if (revision.current?.intent !== intent) revision.current = { intent, clientKey: `teaching-compare:${crypto.randomUUID()}` };
    const input = buildSelfCompareRevision({ observation: recorded, referenceSourceId: answerKey.referenceSourceId, choice, clientKey: revision.current.clientKey });
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
      const head = await readInlineAttemptObservationHead(recorded.id, client);
      if (!head) { setUnavailable(true); setError("这条作答记录已撤回，无法继续核对。"); return; }
      setRecorded(head); setChecked(Boolean(head.referenceCheck));
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
    {!recorded || draftConflict ? <form className="space-y-2" onSubmit={(event) => { void submit(event); }}>
      {draftConflict ? <div role="status" className="space-y-1 text-xs text-amber-800"><p>{draftConflict === "course_changed" ? "此答案提交时所属课程已改变。原答案和提交请求已保留为只读，请到原课程的学习记录核实保存结果。" : "当前题干与原草稿不一致。原草稿已保留为只读，请重新读取活动，避免将旧答案提交到新题目。"}</p><p className="whitespace-pre-wrap">原草稿题目：{initialDraft?.prompt}</p></div> : null}
      {initialDraft?.submission && !draftConflict ? <p role="status" className="text-xs text-zinc-600">已恢复上次提交的原答案。请重新确认保存结果，再继续查看参考；会沿用原来的作答记录。</p> : null}
      <label className="block text-xs text-zinc-700">记录的技能<input className="mt-1 block w-full rounded-md border border-zinc-200 bg-white px-2 py-2" list={skillListId} placeholder={prompt.trim()} value={skillLabel} maxLength={200} disabled={!ready || Boolean(draftConflict) || pending || Boolean(submission.current)} onChange={(event) => { skillEdited.current = true; setSkillLabel(event.target.value); onDraftChange({ answer, skillLabel: event.target.value, prompt }); }} /></label>
      <datalist id={skillListId}>{skillOptions.map((label) => <option key={label} value={label} />)}</datalist>
      {skillReuseHint ? <p className="text-xs leading-6 text-amber-800" role="status">与已有技能「{skillReuseHint}」仅空白/全半角/大小写不同。建议复用该名称以便摘要归并；不会自动改写你的输入。<button type="button" className="ml-2 font-medium text-emerald-800 underline" disabled={!ready || Boolean(draftConflict) || pending || Boolean(submission.current)} onClick={() => { skillEdited.current = true; setSkillLabel(skillReuseHint); onDraftChange({ answer, skillLabel: skillReuseHint, prompt }); }}>使用「{skillReuseHint}」</button></p> : null}
      <label className="block text-xs text-zinc-700">我的原答案<textarea className="mt-1 min-h-24 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm" value={answer} maxLength={20_000} disabled={!ready || Boolean(draftConflict) || pending || Boolean(submission.current) || context.status === "completed"} onChange={(event) => { setAnswer(event.target.value); onDraftChange({ answer: event.target.value, skillLabel, prompt }); }} /></label>
      <button type="submit" className={ui.primary} disabled={!ready || Boolean(draftConflict) || pending || !context.courseId || !skillLabel.trim() || !answer.trim() || context.status === "completed"}>{draftConflict ? "原草稿已保留（只读）" : pending ? "正在保存…" : submission.current ? "重新确认原答案已保存" : "提交原答案，再看参考"}</button>
    </form> : <div className="space-y-2">
      <p className="text-xs font-medium text-zinc-700">原答案已保存</p><p className="whitespace-pre-wrap text-sm text-zinc-800">{recorded.answer}</p>
      {answerKey ? <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-900/5"><p className="mb-2 text-xs font-medium text-zinc-600">参考答案 · 请自行核对</p>{answerKey.answer ? <LearningProse text={answerKey.answer} /> : <p className="text-xs text-zinc-500">这道题没有紧接的参考答案，已保留未核对记录。</p>}</div> : <button type="button" className={ui.secondary} disabled={pending || !attemptId} onClick={() => { if (attemptId) void readAnswer(attemptId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取参考答案")); }}>重新读取参考答案</button>}
      {!checked && !rereadNeeded && answerKey?.answer && answerKey.referenceSourceId ? <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={pending} onClick={() => { void compare("match"); }}>我答对了</button><button type="button" className={ui.secondary} disabled={pending} onClick={() => { void compare("mismatch"); }}>我答错了</button><button type="button" className={ui.quiet} disabled={pending} onClick={() => setChecked(true)}>暂不核对，保留未核对记录</button></div> : null}
      {rereadNeeded ? <button type="button" className={ui.secondary} disabled={pending} onClick={() => { void rereadComparison(); }}>重新读取核对记录</button> : null}
      {answerKey?.answer && !answerKey.referenceSourceId ? <p className="text-xs text-zinc-600">参考答案没有关联可核验材料，本次保留为未核对。</p> : null}
      {checked ? <p role="status" className="text-xs text-zinc-600">{recorded.outcome === "correct" ? "已保存你自对照后的正确判断，仍未经独立评分。" : recorded.outcome === "incorrect" ? "已记录需要复查，后续可安排复测。" : "已保留未核对记录。"}</p> : null}
    </div>}
    {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
  </div>;
}
