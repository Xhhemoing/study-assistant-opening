"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningAttempt, LearningObservation, MatrixExerciseSpec, SourceRecord } from "@aistudy/contracts";
import { matrixExerciseSkillLabel, matrixExerciseStem } from "@aistudy/domain";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { PracticeDraftRecovery, PracticeDraftShelf } from "./practice-draft-recovery";
import { assertPracticeAttempt, practiceScope, readPracticeDraft, readPracticeRecord, restoredPracticeAssistance, runPracticeRequest, usePracticeDraft, type PracticeContinuity } from "./practice-draft";
import { raiseAssistanceOnly, isAssistanceAllowed } from "./reference-check";

type Key = MatrixExerciseSpec["exerciseKey"];
const KEYS: Key[] = ["dimensions", "addition", "scalar", "multiplication"];
const reasonText: Record<string, string> = {
  ambiguous_input: "答案格式无法识别，请按示例使用数组格式。",
  unsupported_number: "只支持整数或带引号的分数；分母不能为零。",
  resource_limit: "答案超出本题可处理范围。",
  missing_or_unsupported_spec: "题目规格不可用，可在课程历史中手动核对。",
  version_changed: "材料或题目版本已改变，未自动判分。",
  spec_identity_mismatch: "题目与当前评价规格不一致，未自动判分。",
};

/** Built-in deterministic questions use the same session/attempt/observation history as ordinary work. */
type Props = { courseId: string; initialKey?: Key; initialVariant?: number; sources: SourceRecord[]; onRecorded: () => void; onBack: () => void };
export function MatrixExerciseForm(props: Props) {
  return <MatrixController key={practiceScope(props.courseId, "matrix")} {...props} />;
}
function MatrixController(props: Props) {
  const continuity = usePracticeDraft(practiceScope(props.courseId, "matrix"), { matrixKey: props.initialKey ?? "multiplication", matrixVariant: props.initialVariant ?? 0 });
  return <div className="space-y-3"><MatrixForm key={continuity.draft.id} {...props} continuity={continuity} /><PracticeDraftShelf continuity={continuity} /></div>;
}
function MatrixForm({ courseId, sources, onRecorded, onBack, initialKey, initialVariant, continuity }: Props & { continuity: PracticeContinuity }) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const scope = practiceScope(courseId, "matrix");
  const { draft, patch, ready, storageWarning, requireSaved } = continuity;
  const [restored, setRestored] = useState(Boolean(draft.start || draft.attemptId || draft.submission));
  const { matrixKey: key, matrixVariant: variant, sourceId, answer, assistance, deliveredAssistance } = draft.fields;
  const setKey = (matrixKey: Key) => patch({ fields: { matrixKey } });
  const setSourceId = (value: string) => patch({ fields: { sourceId: value } });
  const setAnswer = (value: string) => patch({ fields: { answer: value } });
  const setAssistance = (value: LearningObservation["assistance"]) => patch({ fields: { assistance: raiseAssistanceOnly(value, deliveredAssistance) } });
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [record, setRecord] = useState<LearningObservation | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function acceptAttempt(next: LearningAttempt, expectedRequestKey: string) {
    if (!next.matrixExercise) throw new Error("矩阵题目暂不可用，草稿已保留。");
    const checkpoint = readPracticeDraft(scope, null, draft.id) ?? draft;
    assertPracticeAttempt(checkpoint, next, expectedRequestKey);
    patch({ attemptId: next.id });
    const state = await readPracticeRecord(client, courseId, next, checkpoint.observationId);
    if (readPracticeDraft(scope, null, draft.id)?.attemptId !== next.id || readPracticeDraft(scope, null, draft.id)?.start?.clientKey !== expectedRequestKey) return;
    setAttempt(next); setRecord(state.observation); setRestored(false);
    patch(current => ({ observationId: state.observation?.id ?? null, fields: {
      ...restoredPracticeAssistance(current.fields, state.deliveredAssistance),
    } }));
  }
  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (pendingRef.current || !ready || (!draft.start && !sourceId)) return;
    pendingRef.current = true;
    const request = patch(current => ({ start: current.start ?? { sessionId: null, clientKey: `matrix-start:${crypto.randomUUID()}`, createInput: null,
      sessionInput: { courseId, sourceIds: [sourceId], skillLabel: matrixExerciseSkillLabel(key) } } })).start!;
    setPending(true); setError("");
    try {
      requireSaved();
      const next = await runPracticeRequest(`${scope}:start:${request.clientKey}`, async () => {
        if (!request.sessionId) {
          if (!request.sessionInput) throw new Error("练习会话不可用，草稿已保留。");
          request.sessionId = (await client.createSession(request.sessionInput)).id;
          patch({ start: request });
          requireSaved();
        }
        request.createInput ??= { sessionId: request.sessionId, clientKey: request.clientKey, matrixExercise: { sourceId, exerciseKey: key, variant } };
        patch({ start: request });
        requireSaved();
        const created = await client.createAttempt(request.createInput);
        assertPracticeAttempt(readPracticeDraft(scope, null, draft.id) ?? draft, created, request.clientKey);
        patch({ attemptId: created.id });
        return created;
      });
      await acceptAttempt(next, request.clientKey);
    } catch (reason) { setRestored(true); setError(reason instanceof Error ? reason.message : "无法恢复练习，草稿已保留"); }
    finally { pendingRef.current = false; setPending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!attempt || pendingRef.current) return;
    pendingRef.current = true;
    const submission = patch(current => ({ submission: current.submission ?? { attemptId: attempt.id, input: { clientKey: `matrix-answer:${crypto.randomUUID()}`, answer,
      assistance: raiseAssistanceOnly(assistance, deliveredAssistance), outcome: "unverified" as const, verdictSource: "self_report" as const } } })).submission!;
    setPending(true); setError("");
    try {
      if (draft.submission) {
        const existing = await readPracticeRecord(client, courseId, attempt, draft.observationId);
        if (existing.observation) { setRecord(existing.observation); onRecorded(); return; }
      }
      requireSaved();
      const next = await runPracticeRequest(`${scope}:submit:${submission.input.clientKey}`, () => client.submitAttempt(submission.attemptId, submission.input));
      if (readPracticeDraft(scope, null, draft.id)?.attemptId !== submission.attemptId) { onRecorded(); return; }
      patch({ observationId: next.id });
      const state = await readPracticeRecord(client, courseId, { ...attempt, observationId: next.id });
      if (readPracticeDraft(scope, null, draft.id)?.attemptId !== submission.attemptId) { onRecorded(); return; }
      if (!state.observation) throw new Error("已收到保存回执，尚未读取最新记录，请保留答案后重试。");
      setRecord(state.observation); onRecorded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，原答案已锁定，请重试同一次保存"); }
    finally { pendingRef.current = false; setPending(false); }
  }
  async function dispute() {
    if (!record || pendingRef.current) return;
    pendingRef.current = true;
    const disputeKey = draft.disputeKey ?? `matrix-dispute:${crypto.randomUUID()}`;
    patch({ disputeKey });
    setPending(true); setError("");
    try {
      requireSaved();
      const next = await client.reviseObservation({ rootObservationId: record.rootObservationId ?? record.id,
        revisesObservationId: record.id, expectedHead: record.id, clientKey: disputeKey, revisionKind: "replace",
        reason: "学生对内置矩阵题自动评价有异议，暂停将其作为已核验答案。",
        replacement: { answer: record.answer, outcome: "unverified", assistance: record.assistance, verdictSource: "self_report", referenceSourceId: null } });
      if (next.observation) {
        if (readPracticeDraft(scope, null, draft.id)?.attemptId !== record.attemptId) { onRecorded(); return; }
        patch({ observationId: next.observation.id });
        const history = await client.getObservationHistory(next.observation.id);
        const head = history.revisions.find(row => row.id === history.headObservationId);
        if (!head || head.revisionKind === "retract") throw new Error("记录已更新，请到课程历史核对。");
        setRecord(head);
      }
      setMessage("已保留原评价并标记待核验。可到课程历史中核对和纠正。"); onRecorded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存异议，请刷新课程历史核对"); }
    finally { pendingRef.current = false; setPending(false); }
  }
  function nextQuestion() {
    continuity.startAnother({ sourceId, matrixKey: key, matrixVariant: (variant + 1) % 9 });
  }
  return <fieldset disabled={!ready} aria-busy={!ready} className="space-y-3 border-t border-zinc-200 pt-4">
    {!ready ? <p className="text-sm text-zinc-500" role="status">正在读取矩阵练习草稿…</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-zinc-800">内置矩阵练习</h3>
      <button type="button" disabled={pending} onClick={onBack} className="rounded border border-zinc-200 px-3 py-2 text-sm">返回普通练习</button></div>
    {ready && ((initialKey && key !== initialKey) || (initialVariant !== undefined && variant !== initialVariant)) ? <p className="text-xs text-zinc-600" role="status">已恢复此前的{matrixExerciseSkillLabel(key)}第 {variant + 1} 组草稿，新入口的选择不会覆盖原题。</p> : null}
    <p className="text-xs text-zinc-500">本次题组：{variant + 1}</p>
    <p className="text-xs leading-6 text-zinc-500">题目由内置规则生成，使用精确计算核对。材料仅用于课程与版本关联，题目并非从材料中抽取。</p>
    {storageWarning ? <p className="text-xs text-amber-800" role="status">草稿暂时只在当前页面内保留，刷新前请复制答案。</p> : null}
    {restored ? <PracticeDraftRecovery courseId={courseId} answer={answer} pending={pending} onResume={() => void start()} /> : !attempt ? <form onSubmit={start} className="space-y-3">
      <label className="block text-sm">题型<select value={key} disabled={pending} onChange={event => setKey(event.target.value as Key)} className="ml-2 rounded border border-zinc-200 bg-white px-3 py-2">
        {KEYS.map(value => <option key={value} value={value}>{matrixExerciseSkillLabel(value)}</option>)}</select></label>
      <label className="block text-sm">关联材料<select required value={sourceId} disabled={pending} onChange={event => setSourceId(event.target.value)} className="ml-2 max-w-full rounded border border-zinc-200 bg-white px-3 py-2">
        <option value="">选择可用课程材料</option>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
      {sources.length === 0 ? <p className="text-xs text-amber-800">请先添加并完成解析一份材料，再开始内置练习。</p> : null}
      <button disabled={pending || !sourceId} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "正在开始…" : "开始矩阵练习"}</button>
    </form> : record ? <div className="space-y-3" role="status">
      <p className="text-sm font-medium">{record.serverEvaluation
        ? record.serverEvaluation.decision === "correct" ? "精确核算：本次答案正确" : record.serverEvaluation.decision === "incorrect" ? "精确核算：本次答案有误" : "本次未能自动判定"
        : "本次记录待核验"}</p>
      {record.serverEvaluation?.decision === "abstain" ? <p className="text-xs text-amber-800">{reasonText[record.serverEvaluation.reasonCodes[0] ?? ""] ?? "请保留答案并到课程历史中手动核对。"}</p> : null}
      <p className="whitespace-pre-wrap break-words text-sm text-zinc-700">原答案：{record.answer}</p>
      <p className="text-xs text-zinc-500">本次结果只覆盖这道题；重复同题的已知反馈也会计入帮助，不代表掌握或延迟学习效果。</p>
      {record.eligibility ? <LearningEvidenceEligibilityDetails eligibility={record.eligibility} /> : null}
      {message ? <p className="text-xs text-zinc-700">{message}</p> : null}
      <div className="flex flex-wrap gap-2">{record.serverEvaluation ? <button type="button" disabled={pending} onClick={() => void dispute()} className="rounded border border-zinc-200 px-3 py-2 text-sm">评价有异议，标为待核验</button> : null}
        <button type="button" disabled={pending} onClick={nextQuestion} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white">换一道题</button></div>
    </div> : <form onSubmit={submit} className="space-y-3">
      <p className="whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm leading-7">{matrixExerciseStem(attempt.matrixExercise!)}</p>
      <label className="block text-sm">我的答案<textarea required maxLength={2000} rows={3} value={answer} disabled={pending || Boolean(draft.submission)} onChange={event => setAnswer(event.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2" /></label>
      <label className="block text-sm">本次帮助<select required value={assistance} disabled={pending || Boolean(draft.submission)} onChange={event => setAssistance(event.target.value as LearningObservation["assistance"])} className="ml-2 rounded border border-zinc-200 bg-white px-3 py-2">
        <option value="unknown" disabled={!isAssistanceAllowed("unknown", deliveredAssistance)}>尚未确认</option><option value="independent" disabled={!isAssistanceAllowed("independent", deliveredAssistance)}>独立作答</option><option value="hinted" disabled={!isAssistanceAllowed("hinted", deliveredAssistance)}>使用了提示</option><option value="revealed">看过答案或解析</option></select></label>
      <button disabled={pending || !answer.trim()} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "正在保存…" : draft.submission ? "重试保存同一答案" : "保存并核算"}</button>
    </form>}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
  </fieldset>;
}
