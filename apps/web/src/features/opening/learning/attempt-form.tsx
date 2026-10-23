"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type SetStateAction } from "react";
import type { LearningAttempt, LearningAttemptCreateInput, LearningObservation, MatrixExerciseSpec, SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { AssistantView } from "../assistant/assistant-view";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { AiGradingPhotoFields } from "./ai-grading-photo";
import { ObservationRevisionCard } from "./observation-revision-card";
import { StageActionBar } from "./stage-action-bar";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import { PracticeDraftRecovery, PracticeDraftShelf } from "./practice-draft-recovery";
import { formatRetestSubmitError, withRetestSubmit, type RetestAttemptPrefill } from "./retest-attempt";
import { ReferenceCheckStep } from "./reference-check-step";
import {
  isAssistanceAllowed,
  preselectAssistance,
  raiseAssistanceOnly,
} from "./reference-check";
import { collectSkillLabelOptions, findSkillLabelReuseHint } from "./skill-label-options";
import { MatrixExerciseForm } from "./matrix-exercise-form";
import { assertPracticeAttempt, practiceScope, readPracticeDraft, readPracticeRecord, restoredPracticeAssistance, runPracticeRequest, usePracticeDraft, type PracticeContinuity, type PracticeFields, type PracticeStart } from "./practice-draft";


function readPracticeSkillPrefill(): string {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("skillLabel")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function practiceQuestionInput(stem: string, sourceId: string): LearningAttemptCreateInput["problem"] {
  const stemSnapshot = stem.trim();
  return stemSnapshot ? { ...(sourceId ? { sourceId } : {}), stemSnapshot, artifactKind: "reference_item" } : undefined;
}

const OUTCOME_LABEL = { correct: "我认为正确", incorrect: "我认为有错", unverified: "尚未核对" } as const;
const ASSISTANCE_OPTIONS: Array<{ value: LearningObservation["assistance"]; label: string }> = [
  { value: "unknown", label: "尚未确认" },
  { value: "independent", label: "独立作答" },
  { value: "hinted", label: "使用了提示" },
  { value: "revealed", label: "看过答案或解析" },
];

type Props = {
  courseId: string;
  initialFocus?: { skillLabel: string; requirementKey: string | null };
  initialProblem?: { sourceId: string; sourceVersion: number; stem: string };
  initialMode?: "matrix" | "practice";
  initialMatrixKey?: MatrixExerciseSpec["exerciseKey"];
  initialMatrixVariant?: number;
  retest?: RetestAttemptPrefill | null;
  skillLabels?: string[];
  onRecorded: () => void;
  onAskAttempt?: (attempt: LearningAttempt) => void;
};

/** A fresh attempt captures server identity/version before any answer or help. */
export function LearningAttemptForm(props: Props) {
  const initialFocus = props.initialFocus ?? (props.initialProblem ? { skillLabel: "随手练习", requirementKey: null } : undefined);
  return <PracticeController key={practiceScope(props.courseId, "ordinary", props.retest, initialFocus, props.initialProblem)} {...props} initialFocus={initialFocus} />;
}

function PracticeController(props: Props) {
  const scope = practiceScope(props.courseId, "ordinary", props.retest, props.initialFocus, props.initialProblem);
  const continuity = usePracticeDraft(scope, { skillLabel: props.retest?.skillLabel ?? props.initialFocus?.skillLabel ?? readPracticeSkillPrefill(), stem: props.retest?.prompt ?? props.initialProblem?.stem ?? "", sourceId: props.initialProblem?.sourceId ?? "", matrixMode: props.initialMode === "matrix" && !props.retest });
  return <div className="space-y-3"><PracticeForm key={continuity.draft.id} {...props} continuity={continuity} /><PracticeDraftShelf continuity={continuity} allowAnother={!props.retest && !props.initialFocus} /></div>;
}

function PracticeForm({ courseId, retest = null, skillLabels: skillLabelsProp, onRecorded, initialMatrixKey, initialMatrixVariant, initialMode, initialFocus, initialProblem, onAskAttempt, continuity }: Props & { continuity: PracticeContinuity }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const diagnostics = useDiagnosticsEnabled();
  const scope = practiceScope(courseId, "ordinary", retest, initialFocus, initialProblem);
  const { draft, patch, ready, storageWarning, requireSaved } = continuity;
  const [restored, setRestored] = useState(Boolean(draft.start || draft.attemptId || draft.submission));
  const { sourceId, referenceSourceId, skillLabel, stem, answer, outcome, assistance, deliveredAssistance, referenceSkipped, matrixMode } = draft.fields;
  function fieldSetter<K extends keyof PracticeFields>(key: K) {
    return (next: SetStateAction<PracticeFields[K]>) => {
      patch(current => ({ fields: { [key]: typeof next === "function" ? (next as (value: PracticeFields[K]) => PracticeFields[K])(current.fields[key]) : next } }));
    };
  }
  const setMatrixMode = fieldSetter("matrixMode");
  const setSourceId = fieldSetter("sourceId");
  const setReferenceSourceId = fieldSetter("referenceSourceId");
  const setSkillLabel = fieldSetter("skillLabel");
  const setStem = fieldSetter("stem");
  const setAnswer = fieldSetter("answer");
  const setOutcome = fieldSetter("outcome");
  const setAssistance = fieldSetter("assistance");
  const setDeliveredAssistance = fieldSetter("deliveredAssistance");
  const setReferenceSkipped = fieldSetter("referenceSkipped");
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [skillOptions, setSkillOptions] = useState<string[]>(skillLabelsProp ?? []);
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [recorded, setRecorded] = useState<LearningObservation | null>(null);
  const [autoGrade, setAutoGrade] = useState(false);
  const [referenceChecked, setReferenceChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpOpenedOnce, setHelpOpenedOnce] = useState(false);

  useEffect(() => {
    if (skillLabelsProp) setSkillOptions(skillLabelsProp);
  }, [skillLabelsProp]);

  useEffect(() => {
    let active = true;
    void createOpeningApi().listSources().then((rows) => {
      if (active) setSources(rows.filter((source) => source.uploadState === "uploaded"));
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取练习材料"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (skillLabelsProp && skillLabelsProp.length > 0) return;
    let active = true;
    void client.getSummary(courseId).then((rows) => {
      if (active) setSkillOptions(collectSkillLabelOptions(rows));
    }).catch(() => { /* skill hints are optional */ });
    return () => { active = false; };
  }, [client, courseId, skillLabelsProp]);

  const skillReuseHint = findSkillLabelReuseHint(skillLabel, skillOptions);
  const skillListId = `opening-skill-labels-${courseId}`;
  const readySources = sources.filter(source => source.parseState === "ready");
  useEffect(() => {
    if (!initialProblem || !ready || restored || draft.start || attempt || pendingRef.current) return;
    void start();
  }, [ready, restored, draft.start, attempt, initialProblem?.sourceId, initialProblem?.sourceVersion]);
  const questionAnchor = initialProblem ? { courseId, sourceId: initialProblem.sourceId, sourceVersion: initialProblem.sourceVersion, purpose: "learning_help" as const } : undefined;
  const gradingPhoto = { workSourceId: draft.fields.workSourceId, workSourceVersion: draft.fields.workSourceVersion, physicalPage: draft.fields.workPhysicalPage };
  const referenceSource = sources.find((source) => source.id === referenceSourceId) ?? null;
  const canReferenceCheck = Boolean(recorded && !recorded.aiEvaluation && referenceSourceId && !referenceChecked && !referenceSkipped);

  async function refreshDeliveredAssistance(attemptId: string) {
    try {
      const snapshot = await client.getAttempt(attemptId);
      if (readPracticeDraft(scope, null, draft.id)?.attemptId !== attemptId) return;
      setDeliveredAssistance(current => current === "revealed" || snapshot.deliveredAssistance === "revealed" ? "revealed" : current === "hinted" || snapshot.deliveredAssistance === "hinted" ? "hinted" : "none");
      setAssistance((current) => {
        const floored = raiseAssistanceOnly(current, snapshot.deliveredAssistance);
        // First load (still unknown) adopts the delivered preselect; later only raises.
        if (current === "unknown" && snapshot.deliveredAssistance !== "none") {
          return preselectAssistance(snapshot.deliveredAssistance);
        }
        return floored;
      });
    } catch {
      /* submit still floors on the server */
    }
  }

  async function acceptAttempt(next: LearningAttempt, expectedRequestKey: string) {
    const checkpoint = readPracticeDraft(scope, null, draft.id) ?? draft;
    assertPracticeAttempt(checkpoint, next, expectedRequestKey);
    patch({ attemptId: next.id });
    const state = await readPracticeRecord(client, courseId, next, checkpoint.observationId);
    if (readPracticeDraft(scope, null, draft.id)?.attemptId !== next.id || readPracticeDraft(scope, null, draft.id)?.start?.clientKey !== expectedRequestKey) return;
    setAttempt(next);
    if (next.stemSnapshot) setStem(next.stemSnapshot);
    setRecorded(state.observation);
    setAutoGrade(false);
    setReferenceChecked(Boolean(state.observation?.referenceCheck));
    patch(current => ({ observationId: state.observation?.id ?? null, fields: {
      ...restoredPracticeAssistance(current.fields, state.deliveredAssistance),
    } }));
    setHelpOpen(false); setHelpOpenedOnce(false); setRestored(false);
  }

  async function start(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pendingRef.current || !ready) return;
    pendingRef.current = true;
    setPending(true); setError("");
    const request = patch(current => ({ start: current.start ?? {
      sessionId: null, clientKey: `attempt-${crypto.randomUUID()}`, createInput: null,
      sessionInput: { courseId, skillLabel: skillLabel.trim(), sourceIds: [...new Set([sourceId, referenceSourceId].filter(Boolean))], ...((retest?.requirementKey ?? initialFocus?.requirementKey) != null ? { requirementKey: retest?.requirementKey ?? initialFocus?.requirementKey } : {}) },
    } })).start!;
    try {
      requireSaved();
      const next = await runPracticeRequest(`${scope}:start:${request.clientKey}`, async () => {
        if (!request.sessionId) {
          if (!request.sessionInput) throw new Error("练习暂时无法读取，原答案已保留。");
          request.sessionId = (await client.createSession(request.sessionInput)).id;
          patch({ start: request });
          requireSaved();
        }
        request.createInput ??= {
          sessionId: request.sessionId, clientKey: request.clientKey,
          ...(questionAnchor ? { contextAnchor: questionAnchor } : {}),
          ...((retest?.requirementKey ?? initialFocus?.requirementKey) != null ? { requirementKey: retest?.requirementKey ?? initialFocus?.requirementKey } : {}),
          ...(stem.trim() ? { problem: practiceQuestionInput(stem, sourceId) } : {}),
        };
        patch({ start: request });
        requireSaved();
        const created = await client.createAttempt(request.createInput);
        assertPracticeAttempt(readPracticeDraft(scope, null, draft.id) ?? draft, created, request.clientKey);
        patch({ start: request, attemptId: created.id });
        return created;
      });
      await acceptAttempt(next, request.clientKey);
    } catch (reason) { setRestored(true); setError(reason instanceof Error ? reason.message : "无法恢复练习，原答案已保留"); }
    finally { pendingRef.current = false; setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attempt || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setError("");
    const submission = patch(current => ({ submission: current.submission ?? { attemptId: attempt.id, input: withRetestSubmit({ clientKey: `answer-${crypto.randomUUID()}`, answer, outcome, assistance: raiseAssistanceOnly(assistance, deliveredAssistance), verdictSource: "self_report", ...(referenceSourceId ? { referenceSourceId } : {}) }, retest?.retestId) } })).submission!;
    try {
      if (draft.submission) {
        const existing = await readPracticeRecord(client, courseId, attempt, draft.observationId);
        if (existing.observation) { setRecorded(existing.observation); onRecorded(); return; }
      }
      requireSaved();
      const result = await runPracticeRequest(`${scope}:submit:${submission.input.clientKey}`, () => client.submitAttempt(submission.attemptId, submission.input));
      if (readPracticeDraft(scope, null, draft.id)?.attemptId !== submission.attemptId) { onRecorded(); return; }
      patch({ observationId: result.id });
      const current = await readPracticeRecord(client, courseId, { ...attempt, observationId: result.id });
      if (readPracticeDraft(scope, null, draft.id)?.attemptId !== submission.attemptId) { onRecorded(); return; }
      if (!current.observation) throw new Error("答案已保存，暂时无法读取结果，请保留原答案后重试。");
      setRecorded(current.observation);
      setAutoGrade(true);
      setAssistance(current.observation.assistance);
      setHelpOpen(false); setHelpOpenedOnce(false);
      onRecorded();
    } catch (reason) { setError(formatRetestSubmitError(reason)); }
    finally { pendingRef.current = false; setPending(false); }
  }

  async function repeatProblem() {
    if (!attempt?.problemId || pendingRef.current) return;
    pendingRef.current = true;
    const request: PracticeStart = { sessionId: attempt.sessionId, sessionInput: null, clientKey: `attempt-${crypto.randomUUID()}`, createInput: null };
    request.createInput = { sessionId: attempt.sessionId, problemId: attempt.problemId, requirementKey: attempt.requirementKey, clientKey: request.clientKey,
      ...(questionAnchor ? { contextAnchor: questionAnchor } : {}) };
    patch({ start: request, attemptId: null, observationId: null, submission: null, fields: { answer: "", outcome: "unverified", assistance: "unknown", referenceSkipped: false, workSourceId: "", workSourceVersion: 0, workPhysicalPage: 1 } });
    setAttempt(null); setRecorded(null); setReferenceChecked(false); setRestored(true);
    setAutoGrade(false);
    // A repeated attempt retains the same session and its delivered assistance floor.
    setPending(true); setError("");
    try {
      requireSaved();
      const next = await runPracticeRequest(`${scope}:start:${request.clientKey}`, () => client.createAttempt(request.createInput!));
      patch({ attemptId: next.id });
      await acceptAttempt(next, request.clientKey);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法重新开始本题，原答案已保留"); }
    finally { pendingRef.current = false; setPending(false); }
  }

  function reset() {
    continuity.startAnother({ skillLabel, stem: retest?.prompt ?? "", sourceId, referenceSourceId });
  }

  async function refreshSources() {
    try { setSources((await createOpeningApi().listSources()).filter(source => source.uploadState === "uploaded")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "文件暂时无法读取，请重试。"); }
  }

  if (ready && matrixMode && !retest) return <MatrixExerciseForm courseId={courseId} initialKey={initialMatrixKey} initialVariant={initialMatrixVariant} sources={readySources} onRecorded={onRecorded} onBack={() => setMatrixMode(false)} />;
  return (
    <fieldset disabled={!ready} aria-busy={!ready} className="space-y-3 border-t border-line pt-4">
      {!ready ? <p className="text-sm text-text-3" role="status">正在恢复练习…</p> : null}
      {attempt || recorded ? <h3 className="text-sm font-semibold text-text">{recorded ? "已保存的作答" : "完成自己的尝试"}</h3> : null}
      {ready && initialMode === "matrix" && !matrixMode && draft.start ? <p className="text-xs text-text-2" role="status">已恢复未完成的练习。也可以保留答案，开始其他练习。</p> : null}
      {storageWarning ? <p className="text-xs text-warn" role="status">答案暂时只在当前页面保留，刷新前请先复制。</p> : null}
      {!attempt && !draft.start && !retest && !initialFocus ? <button type="button" onClick={() => setMatrixMode(true)} className="rounded border border-line px-3 py-2 text-sm text-text">练习内置矩阵题（自动核算）</button> : null}
      {restored ? (
        <PracticeDraftRecovery courseId={courseId} answer={answer} pending={pending} onResume={() => void start()} />
      ) : !attempt ? (
        <form onSubmit={start} className="space-y-3">

          {retest ? (
            <p className="rounded border border-warn/30 bg-warn-soft px-3 py-2 text-xs leading-6 text-warn" role="status">
              补测作答：将携带补测编号提交；完成后由服务器把对应任务标为已完成。
            </p>
          ) : null}
          {retest?.recommendedAt && new Date(retest.recommendedAt).getTime() > Date.now() ? (
            <p className="rounded border border-line bg-surface-2 px-3 py-2 text-xs leading-6 text-text-2" role="status">
              建议最早作答时间尚未到达。仍可提交，但服务器会拒收过早的补测结果。
            </p>
          ) : null}
          {retest?.prompt ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-text-2">补测提示</p>
              <p className="whitespace-pre-wrap break-words rounded border border-line bg-bg px-3 py-2 text-sm leading-6 text-text">{retest.prompt}</p>
            </div>
          ) : null}
          {!initialProblem ? <><label className="block text-sm text-text">
            1. 选主题（技能或练习主题）
            <input
              required
              maxLength={200}
              list={skillListId}
              placeholder="例如：向量张成、导数链式法则；也可输入自己的主题"
              value={skillLabel}
              disabled={pending || Boolean(retest) || Boolean(initialFocus)}
              onChange={(event) => setSkillLabel(event.target.value)}
              className="mt-1 w-full rounded border border-line bg-surface px-3 py-2"
            />
          </label>
          <datalist id={skillListId}>
            {skillOptions.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          {skillReuseHint ? (
            <p className="text-xs leading-6 text-warn" role="status">
              与已有技能「{skillReuseHint}」仅空白/全半角/大小写不同。建议复用该名称以便摘要归并；不会自动改写你的输入。
              <button
                type="button"
                className="ml-2 font-medium text-accent underline"
                onClick={() => setSkillLabel(skillReuseHint)}
              >
                使用「{skillReuseHint}」
              </button>
            </p>
          ) : null}
          </> : <p className="whitespace-pre-wrap break-words text-sm leading-7 text-text">{stem}</p>}
          {!initialProblem ? <>
            <label className="block text-sm text-text">
              本次题干（可直接粘贴）
              <textarea
                maxLength={2000}
                value={stem}
                disabled={pending || Boolean(retest?.prompt)}
                onChange={(event) => setStem(event.target.value)}
                className="mt-1 min-h-20 w-full rounded border border-line bg-surface px-3 py-2"
              />
            </label>
            <p className="text-xs text-text-3">填入题干，保存作答后即可自动批改；无需上传材料。</p>
          </> : null}
          <div className="sticky top-0 z-10 bg-surface py-2">
            <button
              disabled={pending || !skillLabel.trim() || (!!sourceId && !stem.trim())}
              className="rounded bg-ink px-3 py-2 text-sm text-on-ink disabled:opacity-50"
            >
              {pending ? "正在开始…" : retest ? "开始补测作答" : "开始本次练习"}
            </button>
            {sourceId && !stem.trim() ? <p role="status" className="mt-1 text-xs text-warn">已选题目来源，请填写本次题干后开始。</p> : null}
          </div>
          {!initialProblem ? <details className="rounded border border-line bg-bg/50 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-text-2">关联题目或参考材料（可选）</summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-text-3">有原题或参考解析时，可在此关联材料。</p>
              <label className="block text-sm text-text">
                题目来源（可选）
                <select
                  value={sourceId}
                  disabled={pending}
                  onChange={(event) => setSourceId(event.target.value)}
                  className="mt-1 w-full rounded border border-line bg-surface px-3 py-2"
                >
                  <option value="">不关联资料，使用粘贴题干</option>
                  {readySources.map((source) => (
                    <option key={source.id} value={source.id}>{source.name}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-text">
                答案/解析来源（可选）
                <select
                  value={referenceSourceId}
                  disabled={pending}
                  onChange={(event) => setReferenceSourceId(event.target.value)}
                  className="mt-1 w-full rounded border border-line bg-surface px-3 py-2"
                >
                  <option value="">暂不绑定参考；提交后无自对照步骤</option>
                  {readySources.map((source) => (
                    <option key={source.id} value={source.id}>{source.name}</option>
                  ))}
                </select>
              </label>
              {!stem.trim() ? (
                <p className="rounded border border-warn/30 bg-warn-soft px-3 py-2 text-xs leading-6 text-warn" role="status">
                  填入完整题干后，之后可以安排重做这道题。
                </p>
              ) : null}
              {sourceId && !stem.trim() ? (
                <p className="text-xs text-text-3">请补充题干，让系统知道你在回答哪道题。</p>
              ) : null}
            </div>
          </details> : null}
        </form>
      ) : recorded ? (
        <div className="space-y-3">
          <p className="text-sm text-text" role="status">原答案已保存。</p>
          <ObservationRevisionCard record={recorded} autoGrade={autoGrade} gradingPhoto={gradingPhoto.workSourceId ? gradingPhoto : undefined} completionAction={initialProblem ? { label: "结束练习", href: "/opening/today" } : undefined} onChanged={onRecorded} onUpdated={next => {
            const current = readPracticeDraft(scope, null, draft.id);
            if (!current || current.attemptId !== next.attemptId || current.start?.sessionId !== next.sessionId) return;
            setAutoGrade(false); setRecorded(next); patch({ observationId: next.id });
          }} />
          {diagnostics && recorded.eligibility ? <LearningEvidenceEligibilityDetails eligibility={recorded.eligibility} /> : null}
          {canReferenceCheck ? (
            <ReferenceCheckStep
              observation={recorded}
              referenceSourceId={referenceSourceId}
              referenceSourceName={referenceSource?.name}
              onChecked={(next) => {
                const current = readPracticeDraft(scope, null, draft.id);
                if (!current || current.attemptId !== next.attemptId || current.start?.sessionId !== next.sessionId) { onRecorded(); return; }
                setRecorded(next);
                patch({ observationId: next.id });
                setReferenceChecked(true);
                onRecorded();
              }}
              onSkip={() => setReferenceSkipped(true)}
            />
          ) : null}
          {referenceSkipped ? (
            <p className="text-xs leading-6 text-text-3" role="status">已跳过参考核对，保持自报结果。</p>
          ) : null}
          {onAskAttempt ? <button type="button" className="min-h-11 text-sm text-accent underline underline-offset-4" onClick={() => onAskAttempt(attempt)}>围绕本次作答继续提问</button> : <details className="border-t border-line pt-3"><summary className="min-h-10 cursor-pointer text-sm text-text-2">围绕本次作答继续提问</summary><div className="mt-3 h-[36rem] max-h-[75dvh]"><AssistantView embedded startFresh initialCourseId={courseId} initialSourceIds={attempt.sourceIds} learningAttempt={attempt} /></div><p className="mt-2 text-xs leading-6 text-text-3">后续帮助仍关联这次作答；已保存的原答案不会被重写。</p></details>}
          <div className="flex flex-wrap gap-2">
            {attempt.problemId ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => void repeatProblem()}
                className="rounded border border-line px-3 py-2 text-sm text-text disabled:opacity-50"
              >
                再次练习同题（保留历史帮助）
              </button>
            ) : null}
            {!initialProblem ? <button
              type="button"
              disabled={pending}
              onClick={reset}
              className="rounded border border-line px-3 py-2 text-sm text-text disabled:opacity-50"
            >
              开始其他练习
            </button> : null}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-text-3">
            本次练习已开始：{attempt.skillLabel}。
            {attempt.problemId ? "题目已记录。" : "本次先保存答案；需要评分时，可开始新练习并填写完整题干。"}
            {deliveredAssistance !== "none" ? ` 本次已使用的帮助：${deliveredAssistance === "revealed" ? "看过答案或解析" : "提示"}。` : null}
          </p>
          {attempt.stemSnapshot ? <p className="whitespace-pre-wrap break-words rounded border border-line bg-bg/50 px-3 py-2 text-sm leading-7 text-text">{attempt.stemSnapshot}</p> : null}
          {draft.submission ? <p className="text-xs text-warn" role="status">正在确认上次保存结果，请先保留原答案。</p> : null}
          <form onSubmit={submit} onKeyDown={event => {
            if (event.key !== "Enter") return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
            if ((event.ctrlKey || event.metaKey) && event.target instanceof HTMLTextAreaElement) { event.preventDefault(); event.currentTarget.requestSubmit(); }
          }} className="space-y-3">
            <p className="text-xs leading-6 text-text-3">2. 作答 · 3. 保存</p>
            <label className="block text-sm text-text">
              我的答案
              <textarea
                maxLength={20000}
                value={answer}
                disabled={pending || Boolean(draft.submission)}
                onChange={(event) => setAnswer(event.target.value)}
                className="mt-1 min-h-24 w-full rounded border border-line bg-surface px-3 py-2"
              />
            </label>
            {attempt.problemId ? <AiGradingPhotoFields sources={sources} value={gradingPhoto} onChange={next => patch({ fields: { workSourceId: next.workSourceId, workSourceVersion: next.workSourceVersion, workPhysicalPage: next.physicalPage } })} disabled={pending || Boolean(draft.submission)} onRefresh={() => void refreshSources()} /> : null}
            <label className="block text-sm text-text">
              自报结果
              <select
                value={outcome}
                disabled={pending || Boolean(draft.submission)}
                onChange={(event) => setOutcome(event.target.value as LearningObservation["outcome"])}
                className="ml-2 rounded border border-line bg-surface px-2 py-1"
              >
                {Object.entries(OUTCOME_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <details className="rounded border border-line bg-bg/50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-text-2">帮助等级（可选）</summary>
              <label className="mt-2 block text-sm text-text">
                本次帮助
                <select
                  value={assistance}
                  disabled={pending || Boolean(draft.submission)}
                  onChange={(event) => {
                    const next = event.target.value as LearningObservation["assistance"];
                    setAssistance(raiseAssistanceOnly(next, deliveredAssistance));
                  }}
                  className="ml-2 rounded border border-line bg-surface px-2 py-1"
                >
                  {ASSISTANCE_OPTIONS.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={!isAssistanceAllowed(option.value, deliveredAssistance)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </details>
            <StageActionBar stage={pending ? "processing" : error ? "failed" : "draft"}
              message={pending ? "正在保存原答案…" : undefined}
              primary={{ type: "submit", label: draft.submission ? "重试保存同一答案" : attempt.problemId ? "保存并批改" : "保存当前答案",
                disabled: pending || Boolean(initialProblem && !answer.trim() && !gradingPhoto.workSourceId) }} />
          </form>
          <div className="border-t border-line pt-3">
            <button
              type="button"
              disabled={pending || Boolean(draft.submission)}
              aria-expanded={onAskAttempt ? undefined : helpOpen}
              onClick={() => {
                if (onAskAttempt) { onAskAttempt(attempt); return; }
                setHelpOpenedOnce(true);
                setHelpOpen((open) => !open);
                if (attempt) void refreshDeliveredAssistance(attempt.id);
              }}
              className="text-sm text-accent underline"
            >
              {onAskAttempt ? "问本题" : helpOpen ? "收起本次练习辅导" : "需要时再打开辅导（默认收起）"}
            </button>
            {!onAskAttempt && helpOpenedOnce ? (
              <div className={helpOpen ? "mt-2" : "hidden"} aria-hidden={!helpOpen}>
                <AssistantView learningAttempt={attempt} />
              </div>
            ) : null}
            <p className="mt-2 text-xs text-text-3">
              {onAskAttempt ? "本题辅导在辅助区继续，帮助关联本次作答。" : "辅导嵌在底部且默认收起。"}使用保存模式记录可取回的提示或解析；不证明你已阅读。先保留自己的尝试，再对照参考；提交前获取提示或解析会记录帮助。
            </p>
          </div>
        </div>
      )}
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </fieldset>
  );
}
