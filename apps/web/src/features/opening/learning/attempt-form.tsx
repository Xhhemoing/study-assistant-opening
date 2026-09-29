"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningAttempt, LearningObservation, SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { AssistantView } from "../assistant/assistant-view";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";

const OUTCOME_LABEL = { correct: "我认为正确", incorrect: "我认为有错", unverified: "尚未核对" } as const;

type Props = { courseId: string; onRecorded: () => void };

/** A fresh attempt captures server identity/version before any answer or help. */
export function LearningAttemptForm({ courseId, onRecorded }: Props) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [skillLabel, setSkillLabel] = useState("");
  const [stem, setStem] = useState("");
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [answer, setAnswer] = useState("");
  const [outcome, setOutcome] = useState<LearningObservation["outcome"]>("unverified");
  const [assistance, setAssistance] = useState<LearningObservation["assistance"]>("unknown");
  const [recorded, setRecorded] = useState<LearningObservation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpOpenedOnce, setHelpOpenedOnce] = useState(false);
  const startRequest = useRef<{ fingerprint: string; sessionId: string | null; clientKey: string } | null>(null);
  const repeatKey = useRef<string | null>(null);
  const submitRequest = useRef<{ fingerprint: string; clientKey: string } | null>(null);

  useEffect(() => {
    let active = true;
    void createOpeningApi().listSources().then((rows) => {
      if (active) setSources(rows.filter((source) => source.uploadState === "uploaded" && source.parseState === "ready"));
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取练习材料"); });
    return () => { active = false; };
  }, []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError("");
    const fingerprint = JSON.stringify([courseId, skillLabel.trim(), sourceId, stem.trim()]);
    if (startRequest.current?.fingerprint !== fingerprint) {
      startRequest.current = { fingerprint, sessionId: null, clientKey: `attempt-${crypto.randomUUID()}` };
    }
    const request = startRequest.current;
    try {
      if (!request.sessionId) request.sessionId = (await client.createSession({ courseId, skillLabel: skillLabel.trim(), sourceIds: sourceId ? [sourceId] : [] })).id;
      const next = await client.createAttempt({
        sessionId: request.sessionId,
        clientKey: request.clientKey,
        ...(sourceId && stem.trim() ? { problem: { sourceId, stemSnapshot: stem.trim(), artifactKind: "reference_item" as const } } : {}),
      });
      setAttempt(next); setRecorded(null); setHelpOpen(false); setHelpOpenedOnce(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法开始练习"); }
    finally { setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attempt || pending) return;
    setPending(true); setError("");
    const fingerprint = JSON.stringify([attempt.id, answer, outcome, assistance]);
    if (submitRequest.current?.fingerprint !== fingerprint) submitRequest.current = { fingerprint, clientKey: `answer-${crypto.randomUUID()}` };
    try {
      const result = await client.submitAttempt(attempt.id, { clientKey: submitRequest.current.clientKey, answer, outcome, assistance, verdictSource: "self_report" });
      setRecorded(result); setHelpOpen(false); setHelpOpenedOnce(false); onRecorded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，答案仍保留在此处"); }
    finally { setPending(false); }
  }

  async function repeatProblem() {
    if (!attempt?.problemId || pending) return;
    setPending(true); setError("");
    repeatKey.current ??= `attempt-${crypto.randomUUID()}`;
    try {
      const next = await client.createAttempt({ sessionId: attempt.sessionId, problemId: attempt.problemId, requirementKey: attempt.requirementKey, clientKey: repeatKey.current });
      setAttempt(next); setRecorded(null); setAnswer(""); setOutcome("unverified"); setAssistance("unknown");
      setHelpOpen(false); setHelpOpenedOnce(false); submitRequest.current = null; repeatKey.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法重新开始本题"); }
    finally { setPending(false); }
  }

  function reset() {
    setAttempt(null); setRecorded(null); setAnswer(""); setOutcome("unverified"); setAssistance("unknown");
    setHelpOpen(false); setHelpOpenedOnce(false); setStem(""); startRequest.current = null; submitRequest.current = null; repeatKey.current = null;
  }

  return (
    <div className="space-y-3 border-t border-zinc-200 pt-4">
      <h3 className="text-sm font-semibold text-zinc-800">记录一次练习</h3>
      {!attempt ? (
        <form onSubmit={start} className="space-y-3">
          <label className="block text-sm text-zinc-800">技能或练习主题<input required maxLength={200} value={skillLabel} disabled={pending} onChange={(event) => setSkillLabel(event.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2" /></label>
          <label className="block text-sm text-zinc-800">材料（可选）<select value={sourceId} disabled={pending} onChange={(event) => setSourceId(event.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2"><option value="">不关联材料，保留为待核验记录</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
          {sourceId ? <label className="block text-sm text-zinc-800">本次题目<textarea required maxLength={2000} value={stem} disabled={pending} onChange={(event) => setStem(event.target.value)} className="mt-1 min-h-20 w-full rounded border border-zinc-200 bg-white px-3 py-2" /></label> : null}
          <p className="text-xs text-zinc-500">开始时由服务器记录题目、材料版本和时间；没有题目或版本的记录仍可保存，资格为待核验。</p>
          <button disabled={pending || !skillLabel.trim() || (!!sourceId && !stem.trim())} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "正在开始…" : "开始本次练习"}</button>
        </form>
      ) : recorded ? (
        <div className="space-y-2" role="status">
          <p className="text-sm text-zinc-800">已保存。自报结果：{OUTCOME_LABEL[recorded.outcome]}。</p>
          <p className="text-xs text-zinc-500">自报正确不等于已核验正确，原始结果与资格分开保留。</p>
          {recorded.eligibility ? <LearningEvidenceEligibilityDetails eligibility={recorded.eligibility} /> : <p className="text-xs text-zinc-500">资格待核验。</p>}
          <div className="flex flex-wrap gap-2">{attempt.problemId ? <button type="button" disabled={pending} onClick={() => void repeatProblem()} className="rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-800 disabled:opacity-50">再次练习同题（保留历史帮助）</button> : null}<button type="button" disabled={pending} onClick={reset} className="rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-800 disabled:opacity-50">开始其他练习</button></div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">本次练习已开始：{attempt.skillLabel}。{attempt.problemId ? "题目与版本已由服务器记录。" : "未关联可核验题目，资格保持待核验。"}</p>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm text-zinc-800">我的答案<textarea maxLength={20000} value={answer} disabled={pending} onChange={(event) => setAnswer(event.target.value)} className="mt-1 min-h-24 w-full rounded border border-zinc-200 bg-white px-3 py-2" /></label>
            <label className="block text-sm text-zinc-800">自报结果<select value={outcome} disabled={pending} onChange={(event) => setOutcome(event.target.value as LearningObservation["outcome"])} className="ml-2 rounded border border-zinc-200 bg-white px-2 py-1">{Object.entries(OUTCOME_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="block text-sm text-zinc-800">本次帮助<select value={assistance} disabled={pending} onChange={(event) => setAssistance(event.target.value as LearningObservation["assistance"])} className="ml-2 rounded border border-zinc-200 bg-white px-2 py-1"><option value="unknown">尚未确认</option><option value="independent">独立作答</option><option value="hinted">使用了提示</option><option value="revealed">看过答案或解析</option></select></label>
            <button disabled={pending} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">{pending ? "正在保存…" : "保存自报结果"}</button>
          </form>
          <button type="button" disabled={pending} aria-expanded={helpOpen} onClick={() => { setHelpOpenedOnce(true); setHelpOpen((open) => !open); }} className="text-sm text-emerald-700 underline">{helpOpen ? "收起本次练习辅导" : "打开本次练习辅导"}</button>
          {helpOpenedOnce ? <div className={helpOpen ? "" : "hidden"} aria-hidden={!helpOpen}><AssistantView learningAttempt={attempt} /></div> : null}
          <p className="text-xs text-zinc-500">本次辅导使用保存模式，记录可取回的提示或解析；这不证明你已阅读。已记录的帮助不会因收起辅导而消失。</p>
        </div>
      )}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
