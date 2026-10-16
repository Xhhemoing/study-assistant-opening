"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningAttempt, LearningObservation, MatrixExerciseSpec, SourceRecord } from "@aistudy/contracts";
import { matrixExerciseSkillLabel, matrixExerciseStem } from "@aistudy/domain";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";

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
export function MatrixExerciseForm({ courseId, sources, onRecorded, onBack }: {
  courseId: string; sources: SourceRecord[]; onRecorded: () => void; onBack: () => void;
}) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [key, setKey] = useState<Key>("multiplication");
  const [variant, setVariant] = useState(0);
  const [sourceId, setSourceId] = useState("");
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [answer, setAnswer] = useState("");
  const [assistance, setAssistance] = useState<LearningObservation["assistance"]>("unknown");
  const [record, setRecord] = useState<LearningObservation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const startRequest = useRef<{ intent: string; sessionId: string | null; clientKey: string } | null>(null);
  const submitRequest = useRef<{ intent: string; clientKey: string } | null>(null);
  const disputed = useRef<string | null>(null);
  const [message, setMessage] = useState("");

  async function start(event: FormEvent) {
    event.preventDefault();
    if (pending || !sourceId) return;
    const intent = JSON.stringify([courseId, sourceId, key, variant]);
    if (startRequest.current?.intent !== intent) startRequest.current = { intent, sessionId: null, clientKey: `matrix-start:${crypto.randomUUID()}` };
    const request = startRequest.current;
    setPending(true); setError("");
    try {
      request.sessionId ??= (await client.createSession({ courseId, sourceIds: [sourceId], skillLabel: matrixExerciseSkillLabel(key) })).id;
      const next = await client.createAttempt({ sessionId: request.sessionId, clientKey: request.clientKey,
        matrixExercise: { sourceId, exerciseKey: key, variant } });
      if (!next.matrixExercise) throw new Error("矩阵题目暂不可用，请重新读取后开始。");
      setAttempt(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法开始练习"); }
    finally { setPending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!attempt || pending) return;
    const intent = JSON.stringify([attempt.id, answer, assistance]);
    if (submitRequest.current?.intent !== intent) submitRequest.current = { intent, clientKey: `matrix-answer:${crypto.randomUUID()}` };
    setPending(true); setError("");
    try {
      const next = await client.submitAttempt(attempt.id, { clientKey: submitRequest.current.clientKey, answer,
        assistance, outcome: "unverified", verdictSource: "self_report" });
      setRecord(next); onRecorded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请保留答案后重试"); }
    finally { setPending(false); }
  }
  async function dispute() {
    if (!record || pending) return;
    disputed.current ??= `matrix-dispute:${crypto.randomUUID()}`;
    setPending(true); setError("");
    try {
      const next = await client.reviseObservation({ rootObservationId: record.rootObservationId ?? record.id,
        revisesObservationId: record.id, expectedHead: record.id, clientKey: disputed.current, revisionKind: "replace",
        reason: "学生对内置矩阵题自动评价有异议，暂停将其作为已核验答案。",
        replacement: { answer: record.answer, outcome: "unverified", assistance: record.assistance, verdictSource: "self_report", referenceSourceId: null } });
      if (next.observation) setRecord(next.observation);
      setMessage("已保留原评价并标记待核验。可到课程历史中核对和纠正。"); onRecorded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法保存异议，请刷新课程历史核对"); }
    finally { setPending(false); }
  }
  function nextQuestion() {
    setAttempt(null); setRecord(null); setAnswer(""); setAssistance("unknown"); setVariant(value => (value + 1) % 9);
    startRequest.current = null; submitRequest.current = null; disputed.current = null; setMessage(""); setError("");
  }
  return <div className="space-y-3 border-t border-zinc-200 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-zinc-800">内置矩阵练习</h3>
      <button type="button" disabled={pending} onClick={onBack} className="rounded border border-zinc-200 px-3 py-2 text-sm">返回普通练习</button></div>
    <p className="text-xs leading-6 text-zinc-500">题目由内置规则生成，使用精确计算核对。材料仅用于课程与版本关联，题目并非从材料中抽取。</p>
    {!attempt ? <form onSubmit={start} className="space-y-3">
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
      <label className="block text-sm">我的答案<textarea required maxLength={2000} rows={3} value={answer} disabled={pending} onChange={event => setAnswer(event.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2" /></label>
      <label className="block text-sm">本次帮助<select required value={assistance} disabled={pending} onChange={event => setAssistance(event.target.value as LearningObservation["assistance"])} className="ml-2 rounded border border-zinc-200 bg-white px-3 py-2">
        <option value="unknown">尚未确认</option><option value="independent">独立作答</option><option value="hinted">使用了提示</option><option value="revealed">看过答案或解析</option></select></label>
      <button disabled={pending || !answer.trim()} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "正在保存…" : "保存并核算"}</button>
    </form>}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
  </div>;
}
