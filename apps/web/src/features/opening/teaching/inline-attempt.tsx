"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningAttempt, LearningObservation, TeachingActivity, TeachingAnswerKey, TeachingHintLevel, TeachingHintResponse } from "@aistudy/contracts";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { buildSelfCompareRevision, referenceCheckFailure, selfCompareRevisionIntentKey } from "../learning/reference-check";
import { collectSkillLabelOptions, findSkillLabelReuseHint } from "../learning/skill-label-options";
import { LearningProse } from "../assistant/learning-prose";
import { ui } from "../design/ui";
import { successfulInteractionHaptic } from "../design/haptics";
import { createTeachingActivityClient } from "./activity-client";
import { createInlineAttemptSubmission, readInlineAttemptObservationHead, type InlineAttemptSubmissionCheckpoint } from "./inline-attempt-submission";
import { createInlineAttemptDrafts, inlineAttemptDraftConflict, inlineAttemptIdentityKey, type InlineAttemptDraft } from "./inline-attempt-drafts";
import { defaultInlineAttemptSkill } from "./inline-attempt-skill";
import { LessonFlow } from "./lesson-flow";
import { MathInput } from "./math-input";
import { FeedbackPanel } from "./feedback-panel";
import { AiGradingResult, canGradeObservation } from "../learning/ai-grading-card";
import { ObservationRevisionCard } from "../learning/observation-revision-card";
import { LearnerStatePanel } from "./learner-state-panel";
import { createInlineAttemptPreparation, type InlineAttemptPreparationCheckpoint } from "./inline-attempt-prepare";
import { HintLadder } from "./hint-ladder";
import { requestTeachingHint, TEACHING_HINT_LABELS } from "./teaching-hint-client";
import { acknowledgeStudyExposure } from "../assistant/study-exposure-ack";

export type InlineAttemptContext = Pick<TeachingActivity, "id" | "courseId" | "sourceIds" | "contentVersion" | "intentSummary" | "status"> & {
  learnerFocus?: TeachingActivity["learnerFocus"];
  questionSkillLabel?: string;
  outlineTitle?: string;
  onCourseAssociated: (activity: TeachingActivity) => void;
  /** Available after the server creates or restores the canonical question identity. */
  onAttemptReady?: (blockId: string, attempt: LearningAttempt) => void;
  /** Called only for a durably saved observation, including restored work. */
  onObservationReady?: (blockId: string, observation: LearningObservation) => void;
};

/** Full reference content is fetched only by an explicit action after the original is saved. */
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
    {!ready ? <p role="status" className="mt-2 text-xs text-text-3">正在恢复本页未完成的作答…</p> : null}
    {ready && restored.unavailable ? <p role="status" className="mt-2 text-xs text-warn">浏览器无法保存答案；本页内跳转仍会保留，刷新或关闭页面后会丢失。请先复制答案。</p> : null}
    {previous.length ? <details className="mt-2 rounded-lg bg-surface-2 p-3 text-xs text-text-2"><summary className="cursor-pointer">查看之前尚未确认保存的答案</summary>{previous.map(([key, draft]) => <div key={key} className="mt-2 space-y-1"><p>{draft.prompt}</p><p className="whitespace-pre-wrap">{draft.answer}</p>{draft.submission ? <p>此答案已发起提交，保存结果请到学习记录确认。</p> : null}</div>)}</details> : null}
  </>;
}

function submissionDraft(checkpoint: InlineAttemptSubmissionCheckpoint): InlineAttemptDraft {
  return { answer: checkpoint.input.answer, skillLabel: checkpoint.input.skillLabel, prompt: checkpoint.input.prompt, submission: checkpoint };
}

export function InlineAttemptForm({ blockId, prompt, context, ready, initialDraft, onDraftChange }: { blockId: string; prompt: string; context: InlineAttemptContext; ready: boolean; initialDraft?: InlineAttemptDraft; onDraftChange: (draft: InlineAttemptDraft | null) => void }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const api = useMemo(() => createOpeningApi(), []);
  const teaching = useMemo(() => createTeachingActivityClient(), []);
  const draftConflict = inlineAttemptDraftConflict(initialDraft, { courseId: context.courseId, prompt });
  const currentScope = useRef({ courseId: context.courseId, prompt });
  currentScope.current = { courseId: context.courseId, prompt };
  const [answer, setAnswer] = useState(initialDraft?.answer ?? "");
  const [skillLabel, setSkillLabel] = useState(() => defaultInlineAttemptSkill({
    draftSkillLabel: initialDraft?.skillLabel, questionSkillLabel: context.questionSkillLabel,
    learnerSkillLabel: context.learnerFocus?.skillLabel, outlineTitle: context.outlineTitle,
  }));
  const [skillEditorOpen, setSkillEditorOpen] = useState(() => !skillLabel.trim());
  // Delayed optional reads must never replace an edited (including cleared) skill.
  const skillEdited = useRef(initialDraft !== undefined);
  const [skillOptions, setSkillOptions] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [recorded, setRecorded] = useState<LearningObservation | null>(null);
  const [autoGrade, setAutoGrade] = useState(false);
  const currentRecordId = useRef<string | null>(null);
  currentRecordId.current = recorded?.id ?? null;
  const revisionReturnedHead = useRef(false);
  const [answerKey, setAnswerKey] = useState<TeachingAnswerKey | null>(null);
  const [checked, setChecked] = useState(false);
  const [rereadNeeded, setRereadNeeded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [courseId, setCourseId] = useState("");
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [hints, setHints] = useState<TeachingHintResponse[]>([]);
  const [hintPending, setHintPending] = useState(false);
  const [hintUnavailable, setHintUnavailable] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreRetry, setRestoreRetry] = useState(0);
  const submission = useRef<ReturnType<typeof createInlineAttemptSubmission> | null>(null);
  const preparation = useRef<ReturnType<typeof createInlineAttemptPreparation> | null>(null);
  const preparedCheckpoint = useRef<InlineAttemptPreparationCheckpoint | undefined>(initialDraft?.preparation);
  const latestDraft = useRef({ answer, skillLabel, prompt });
  latestDraft.current = { answer, skillLabel, prompt };
  function persistDraft(value: Pick<InlineAttemptDraft, "answer" | "skillLabel" | "prompt">) {
    onDraftChange({ ...value, ...(preparedCheckpoint.current ? { preparation: preparedCheckpoint.current } : {}) });
  }
  function prepared(checkpoint: InlineAttemptPreparationCheckpoint) {
    preparedCheckpoint.current = checkpoint;
    setSkillLabel(checkpoint.input.skillLabel);
    onDraftChange({ ...latestDraft.current, skillLabel: checkpoint.input.skillLabel, preparation: checkpoint });
  }
  if (!submission.current && initialDraft?.submission) submission.current = createInlineAttemptSubmission(initialDraft.submission.input, client, {
    checkpoint: initialDraft.submission, onCheckpoint: checkpoint => onDraftChange(submissionDraft(checkpoint)),
  });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const inFlight = useRef(false);
  const revision = useRef<{ intent: string; clientKey: string } | null>(null);
  const onAttemptReady = useRef(context.onAttemptReady);
  onAttemptReady.current = context.onAttemptReady;

  useEffect(() => {
    if (!ready) return;
    let active = true;
    setRestoring(true); setRestoreFailed(false); setError("");
    void teaching.getSubmittedAttempt(context.id, blockId, context.contentVersion).then(async saved => {
      if (!active) return;
      if (!saved) {
        if (!initialDraft?.preparation || draftConflict) return;
        preparation.current ??= createInlineAttemptPreparation(initialDraft.preparation.input, client, { checkpoint: initialDraft.preparation, onCheckpoint: prepared });
        const canonical = await preparation.current.prepare();
        if (!active) return;
        setAttempt(canonical); onAttemptReady.current?.(blockId, canonical);
        return;
      }
      if (!saved.observation) {
        setUnavailable(true); setError("这条作答记录已撤回或不可用，无法继续核对。"); return;
      }
      setRecorded(saved.observation); setAttempt(saved.attempt);
      context.onObservationReady?.(blockId, saved.observation);
      setChecked(Boolean(saved.observation.referenceCheck));
      onAttemptReady.current?.(blockId, saved.attempt);
    }).catch((reason: unknown) => {
      if (active) { setRestoreFailed(true); setError(reason instanceof Error ? reason.message : "无法恢复已保存的作答，请重试。"); }
    }).finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  // initialDraft is the form's fixed restoration checkpoint; edits must not replay recovery.
  }, [ready, teaching, context.id, context.courseId, blockId, context.contentVersion, prompt, restoreRetry]);

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
      if (!skillEdited.current && !submission.current && !preparation.current) setSkillLabel(defaultInlineAttemptSkill({
        questionSkillLabel: context.questionSkillLabel, learnerSkillLabel: context.learnerFocus?.skillLabel, outlineTitle: context.outlineTitle,
        skillOptions: options, knowledge,
      }));
    });
    return () => { active = false; };
  }, [api, client, ready, context.courseId, context.status, context.questionSkillLabel, context.learnerFocus?.skillLabel, context.outlineTitle]);

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

  async function prepare() {
    if (!ready || restoring || restoreFailed || draftConflict || !context.courseId || !skillLabel.trim() || inFlight.current || context.status === "completed") return;
    inFlight.current = true; setPending(true); setError("");
    preparation.current ??= createInlineAttemptPreparation({ activityId: context.id, courseId: context.courseId, blockId, contentVersion: context.contentVersion, sourceIds: context.sourceIds, prompt, skillLabel: skillLabel.trim() }, client, { onCheckpoint: prepared });
    try {
      const canonical = await preparation.current.prepare();
      if (!mounted.current || currentScope.current.courseId !== context.courseId || currentScope.current.prompt !== prompt) return;
      setAttempt(canonical); context.onAttemptReady?.(blockId, canonical);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "本题准备结果未确认，重试会沿用同一请求。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  async function readHint(level: TeachingHintLevel) {
    if (!attempt || inFlight.current || draftConflict || restoring || restoreFailed || level === 4 && !recorded || !recorded && submission.current) return;
    inFlight.current = true; setPending(true); setHintPending(true); setError("");
    try {
      const hint = await requestTeachingHint(attempt, { activityId: context.id, blockId, contentVersion: context.contentVersion }, level);
      if (!mounted.current || currentScope.current.courseId !== context.courseId || currentScope.current.prompt !== prompt) return;
      setHints(previous => [...previous.filter(value => value.level !== hint.level), hint]);
      if (hint.level === 4) setAnswerKey({ answer: hint.text, referenceSourceId: hint.referenceSourceId });
      void acknowledgeStudyExposure(hint.exposureReceipt).catch(() => undefined);
    } catch (reason) {
      if (mounted.current) { setError(reason instanceof Error ? reason.message : "提示暂不可读取，原答案保留。"); if (reason instanceof OpeningApiError && reason.status === 409 && level < 4) setHintUnavailable(true); }
    } finally { inFlight.current = false; setPending(false); setHintPending(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || restoring || restoreFailed || draftConflict || !context.courseId || inFlight.current || context.status === "completed") return;
    inFlight.current = true; setPending(true); setError("");
    submission.current ??= createInlineAttemptSubmission({ activityId: context.id, courseId: context.courseId, blockId, contentVersion: context.contentVersion, sourceIds: context.sourceIds, prompt, skillLabel: skillLabel.trim(), answer }, client, { preparation: preparedCheckpoint.current, onCheckpoint: checkpoint => onDraftChange(submissionDraft(checkpoint)) });
    try {
      const result = await submission.current.submit();
      if (!mounted.current || currentScope.current.courseId !== context.courseId || currentScope.current.prompt !== prompt) return;
      const observation = initialDraft?.submission ? await readInlineAttemptObservationHead(result.observation.id, client) : result.observation;
      if (!mounted.current || currentScope.current.courseId !== context.courseId || currentScope.current.prompt !== prompt) return;
      if (!observation) { setUnavailable(true); setError("这条作答记录已撤回，无法继续核对。"); return; }
      successfulInteractionHaptic();
      setRecorded(observation); setAttempt(result.attempt); setChecked(Boolean(observation.referenceCheck));
      setAutoGrade(!initialDraft?.submission && !observation.aiEvaluation);
      context.onObservationReady?.(blockId, observation);
      context.onAttemptReady?.(blockId, result.attempt);
    } catch (reason) { setError(reason instanceof OpeningApiError && reason.status === 409 ? "学习内容或记录已更新，原答案和提交请求已保留。请重新读取活动或原课程学习记录后再确认。" : reason instanceof Error ? reason.message : "答案保存未确认，可用相同请求重新确认。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  async function compare(choice: "match" | "mismatch") {
    if (context.status === "completed" || !recorded || recorded.aiEvaluation || !answerKey?.referenceSourceId || inFlight.current || checked || rereadNeeded) return;
    const intent = selfCompareRevisionIntentKey(recorded.id, choice, null);
    if (revision.current?.intent !== intent) revision.current = { intent, clientKey: `teaching-compare:${crypto.randomUUID()}` };
    const input = buildSelfCompareRevision({ observation: recorded, referenceSourceId: answerKey.referenceSourceId, choice, clientKey: revision.current.clientKey });
    if (!input) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const result = await client.reviseObservation(input);
      if (result.observation) updatedObservation(result.observation);
      setChecked(true);
    } catch (reason) {
      const failure = referenceCheckFailure(reason);
      setError(failure.message); setRereadNeeded(true);
      if (failure.kind === "unavailable") setUnavailable(true);
    }
    finally { inFlight.current = false; setPending(false); }
  }
  function updatedObservation(observation: LearningObservation) {
    currentRecordId.current = observation.id;
    setAutoGrade(false); setRecorded(observation); setChecked(Boolean(observation.referenceCheck));
    context.onObservationReady?.(blockId, observation);
  }
  async function rereadComparison() {
    if (!recorded || inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      const head = await readInlineAttemptObservationHead(recorded.id, client);
      if (!mounted.current || currentRecordId.current !== recorded.id) return;
      if (!head) { setUnavailable(true); setError("这条作答记录已撤回，无法继续核对。"); return; }
      updatedObservation(head);
      setRereadNeeded(false); revision.current = null;
    } catch (reason) {
      const failure = referenceCheckFailure(reason); setError(failure.message);
      if (failure.kind === "unavailable") setUnavailable(true);
    } finally { inFlight.current = false; setPending(false); }
  }

  if (unavailable) return <p role="alert" className="mt-3 text-xs text-danger">{error || "本条作答记录已不可用，请重新读取活动。"}</p>;
  const nextHint = answerKey ? null : recorded ? 4 : Math.min(4, 1 + hints.reduce((level, hint) => Math.max(level, hint.level), 0)) as TeachingHintLevel;
  const assessed = Boolean(recorded?.aiEvaluation || recorded?.serverEvaluation);
  const feedbackVerdict = assessed ? recorded!.outcome : "unverified";
  return <div className="mt-3 space-y-3 border-t border-line pt-3" data-inline-attempt={blockId}>
    <LessonFlow phase={hintPending ? "hint" : recorded ? checked ? "next" : "feedback" : pending && submission.current ? "submit" : "attempt"}>
    {!context.courseId && context.status !== "completed" ? <div className="space-y-2">
      <p className="text-xs text-text-2">先关联课程，作答才能保存到对应的学习记录。</p>
      <label className="block text-xs text-text-2">学习记录所属课程<select className="mt-1 block w-full rounded-md border border-line bg-surface px-2 py-2" value={courseId} disabled={pending} onChange={(event) => setCourseId(event.target.value)}><option value="">选择已有课程</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
      <button type="button" className={ui.secondary} disabled={!courseId || pending} onClick={() => { void bindCourse(); }}>关联此课程</button>
      {!courses.length ? <p className="text-xs text-text-3">可先到课程页创建课程，再返回作答。</p> : null}
    </div> : null}
    {ready && restoring ? <p role="status" className="text-xs text-text-2">正在恢复已保存的作答…</p> : restoreFailed ? <button type="button" className={ui.secondary} onClick={() => setRestoreRetry(value => value + 1)}>重新读取已保存的作答</button> : !recorded && context.status === "completed" ? <p className="text-xs text-text-2">本题没有可恢复的已提交作答。{initialDraft?.answer ? "本页保留的答案尚未确认保存：" : ""}{initialDraft?.answer ? <span className="block whitespace-pre-wrap">{initialDraft.answer}</span> : null}</p> : !recorded ? <form className="space-y-2" onSubmit={(event) => { void submit(event); }}>
      {draftConflict ? <div role="status" className="space-y-1 text-xs text-warn"><p>{draftConflict === "course_changed" ? "此答案提交时所属课程已改变。原答案和提交请求已保留为只读，请到原课程的学习记录核实保存结果。" : "当前题目与之前作答的题目不一致。原答案已保留为只读，请重新读取活动，再继续作答。"}</p><p className="whitespace-pre-wrap">原题目：{initialDraft?.prompt}</p></div> : null}
      {initialDraft?.submission && !draftConflict ? <p role="status" className="text-xs text-text-2">已恢复上次提交的原答案。请重新确认保存结果，再继续查看参考；会沿用原来的作答记录。</p> : null}
      <p className="break-words text-xs leading-6 text-text-2">记录到：{skillLabel.trim() || "尚未选择技能"}</p>
      <details open={skillEditorOpen} onToggle={event => setSkillEditorOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer py-1 text-xs text-text-3 focus-visible:ring-2 focus-visible:ring-emerald-700">{skillLabel.trim() ? "修正记录的技能" : "选择记录的技能"}</summary>
        <div className="space-y-2 pt-2">
          <label className="block text-xs text-text-2">记录的技能<input className="mt-1 block w-full rounded-md border border-line bg-surface px-2 py-2" list={skillListId} placeholder={prompt.trim()} value={skillLabel} maxLength={200} disabled={!ready || Boolean(draftConflict) || pending || Boolean(submission.current) || Boolean(preparation.current)} onChange={(event) => { skillEdited.current = true; setSkillLabel(event.target.value); persistDraft({ answer, skillLabel: event.target.value, prompt }); }} /></label>
          <datalist id={skillListId}>{skillOptions.map((label) => <option key={label} value={label} />)}</datalist>
          {skillReuseHint ? <p className="text-xs leading-6 text-warn" role="status">与已有技能「{skillReuseHint}」仅空白/全半角/大小写不同。建议复用该名称以便摘要归并；不会自动改写你的输入。<button type="button" className="ml-2 font-medium text-accent underline" disabled={!ready || Boolean(draftConflict) || pending || Boolean(submission.current) || Boolean(preparation.current)} onClick={() => { skillEdited.current = true; setSkillLabel(skillReuseHint); persistDraft({ answer, skillLabel: skillReuseHint, prompt }); }}>使用「{skillReuseHint}」</button></p> : null}
        </div>
      </details>
      <MathInput label="我的原答案" value={answer} maxLength={20_000} disabled={!ready || Boolean(draftConflict) || pending || Boolean(submission.current) || context.status === "completed"} onChange={value => { setAnswer(value); persistDraft({ answer: value, skillLabel, prompt }); }} />
      <button type="submit" className={ui.primary} disabled={!ready || Boolean(draftConflict) || pending || !context.courseId || !skillLabel.trim() || !answer.trim() || context.status === "completed"}>{draftConflict ? "原答案已保留（只读）" : pending ? "正在保存…" : submission.current ? "重新确认原答案已保存" : "提交原答案，再看参考"}</button>
    </form> : <FeedbackPanel verdict={feedbackVerdict} title="原答案已保存" evidence={recorded.aiEvaluation ? "批改结果已记录，可以查看评分要点，或纠正不准确的判断。" : canGradeObservation(recorded) ? "答案保存后可自动批改，也可以手动记录自己的判断。" : checked ? "已保留你的核对结果，尚未经独立评分。" : "先对照参考，再记录自己的判断。"}>
      <LearnerStatePanel observation={recorded} />
      {context.status !== "completed" && (canGradeObservation(recorded) || recorded.aiEvaluation) ? <ObservationRevisionCard record={recorded} autoGrade={autoGrade}
        onUpdated={observation => { revisionReturnedHead.current = true; updatedObservation(observation); }} onChanged={() => {
          // Successful edits already returned the current head. Only withdrawal or
          // unavailability needs a read; a second read could overwrite a later edit.
          if (revisionReturnedHead.current) { revisionReturnedHead.current = false; return; }
          void rereadComparison();
        }} />
        : <><p className="text-xs font-medium text-text-2">封存的原答案</p><p className="whitespace-pre-wrap text-sm text-text">{recorded.answer}</p><AiGradingResult record={recorded} /></>}
      {answerKey ? <div className="rounded-lg bg-surface p-3 ring-1 ring-line"><p className="mb-2 text-xs font-medium text-text-2">参考答案 · 请自行核对</p>{answerKey.answer ? <LearningProse text={answerKey.answer} /> : <p className="text-xs text-text-3">这道题没有紧接的参考答案，已保留未核对记录。</p>}</div> : <p className="text-xs text-text-2">参考解答尚未展开。按需查看后会记录本题解答曝光，封存的首答保持不变。</p>}
      {context.status !== "completed" && !assessed && !checked && !rereadNeeded && answerKey?.answer && answerKey.referenceSourceId ? <div className="flex flex-wrap gap-2"><button type="button" className={ui.secondary} disabled={pending} onClick={() => { void compare("match"); }}>我答对了</button><button type="button" className={ui.secondary} disabled={pending} onClick={() => { void compare("mismatch"); }}>我答错了</button><button type="button" className={ui.quiet} disabled={pending} onClick={() => setChecked(true)}>暂不核对，保留未核对记录</button></div> : null}
      {rereadNeeded ? <button type="button" className={ui.secondary} disabled={pending} onClick={() => { void rereadComparison(); }}>重新读取核对记录</button> : null}
      {!assessed && answerKey?.answer && !answerKey.referenceSourceId ? <p className="text-xs text-text-2">参考答案缺少出处，暂时无法判断对错。你的原答案已保留。</p> : null}
      {checked && !assessed ? <p role="status" className="text-xs text-text-2">{recorded.outcome === "correct" ? "已保存你自对照后的正确判断，仍未经独立评分。" : recorded.outcome === "incorrect" ? "已记录需要复查，后续可安排复测。" : "已保留未核对记录。"}</p> : null}
    </FeedbackPanel>}
    {!restoring && !restoreFailed && !draftConflict && !unavailable ? attempt ? <HintLadder
      delivered={hints.filter(hint => hint.level < 4).map(hint => ({ id: hint.exposureReceipt.id, label: TEACHING_HINT_LABELS[hint.level], text: hint.text }))}
      next={nextHint ? { label: TEACHING_HINT_LABELS[nextHint], pending: hintPending,
        disabled: pending || !recorded && (nextHint === 4 || Boolean(submission.current) || hintUnavailable || context.status === "completed"),
        blockedReason: !recorded && submission.current ? "先确认原答案的保存结果，再继续查看提示。" : !recorded && nextHint === 4 ? "先提交并封存原答案，再按需查看参考解答。" : hintUnavailable && !recorded ? "此版提示不可用；仍可提交作答。" : undefined,
        request: () => { void readHint(nextHint); } } : undefined} />
      : context.status !== "completed" && !submission.current ? <button type="button" className={ui.secondary} disabled={!ready || pending || !context.courseId || !skillLabel.trim()} onClick={() => { void prepare(); }}>{pending ? "正在准备本题…" : preparation.current ? "重新确认本题已准备" : "开始本题并启用提示"}</button> : null : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </LessonFlow>
  </div>;
}
