"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { LearningAttempt, LearningObservation, SourceRecord } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { AssistantView } from "../assistant/assistant-view";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { formatRetestSubmitError, withRetestSubmit, type RetestAttemptPrefill } from "./retest-attempt";
import { ReferenceCheckStep } from "./reference-check-step";
import {
  isAssistanceAllowed,
  preselectAssistance,
  raiseAssistanceOnly,
  type DeliveredAssistance,
} from "./reference-check";
import { collectSkillLabelOptions, findSkillLabelReuseHint } from "./skill-label-options";

const OUTCOME_LABEL = { correct: "我认为正确", incorrect: "我认为有错", unverified: "尚未核对" } as const;
const ASSISTANCE_OPTIONS: Array<{ value: LearningObservation["assistance"]; label: string }> = [
  { value: "unknown", label: "尚未确认" },
  { value: "independent", label: "独立作答" },
  { value: "hinted", label: "使用了提示" },
  { value: "revealed", label: "看过答案或解析" },
];

type Props = {
  courseId: string;
  retest?: RetestAttemptPrefill | null;
  skillLabels?: string[];
  onRecorded: () => void;
};

/** A fresh attempt captures server identity/version before any answer or help. */
export function LearningAttemptForm({ courseId, retest = null, skillLabels: skillLabelsProp, onRecorded }: Props) {
  const client = useMemo(() => createOpeningLearningClient(), []);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [skillOptions, setSkillOptions] = useState<string[]>(skillLabelsProp ?? []);
  const [sourceId, setSourceId] = useState("");
  const [referenceSourceId, setReferenceSourceId] = useState("");
  const [skillLabel, setSkillLabel] = useState(() => retest?.skillLabel ?? "");
  const [stem, setStem] = useState(() => retest?.prompt ?? "");
  const [attempt, setAttempt] = useState<LearningAttempt | null>(null);
  const [answer, setAnswer] = useState("");
  const [outcome, setOutcome] = useState<LearningObservation["outcome"]>("unverified");
  const [assistance, setAssistance] = useState<LearningObservation["assistance"]>("unknown");
  const [deliveredAssistance, setDeliveredAssistance] = useState<DeliveredAssistance>("none");
  const [recorded, setRecorded] = useState<LearningObservation | null>(null);
  const [referenceChecked, setReferenceChecked] = useState(false);
  const [referenceSkipped, setReferenceSkipped] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpOpenedOnce, setHelpOpenedOnce] = useState(false);
  const startRequest = useRef<{ fingerprint: string; sessionId: string | null; clientKey: string } | null>(null);
  const repeatKey = useRef<string | null>(null);
  const submitRequest = useRef<{ fingerprint: string; clientKey: string } | null>(null);

  useEffect(() => {
    if (skillLabelsProp) setSkillOptions(skillLabelsProp);
  }, [skillLabelsProp]);

  useEffect(() => {
    let active = true;
    void createOpeningApi().listSources().then((rows) => {
      if (active) setSources(rows.filter((source) => source.uploadState === "uploaded" && source.parseState === "ready"));
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
  const referenceSource = sources.find((source) => source.id === referenceSourceId) ?? null;
  const canReferenceCheck = Boolean(recorded && referenceSourceId && !referenceChecked && !referenceSkipped);

  async function refreshDeliveredAssistance(attemptId: string) {
    try {
      const snapshot = await client.getAttempt(attemptId);
      setDeliveredAssistance(snapshot.deliveredAssistance);
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

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError("");
    const sessionSources = [...new Set([sourceId, referenceSourceId].filter(Boolean))];
    const fingerprint = JSON.stringify([courseId, skillLabel.trim(), sessionSources, stem.trim()]);
    if (startRequest.current?.fingerprint !== fingerprint) {
      startRequest.current = { fingerprint, sessionId: null, clientKey: `attempt-${crypto.randomUUID()}` };
    }
    const request = startRequest.current;
    try {
      if (!request.sessionId) {
        request.sessionId = (await client.createSession({
          courseId,
          skillLabel: skillLabel.trim(),
          sourceIds: sessionSources,
        })).id;
      }
      const next = await client.createAttempt({
        sessionId: request.sessionId,
        clientKey: request.clientKey,
        ...(sourceId && stem.trim()
          ? { problem: { sourceId, stemSnapshot: stem.trim(), artifactKind: "reference_item" as const } }
          : {}),
      });
      setAttempt(next);
      setRecorded(null);
      setReferenceChecked(false);
      setReferenceSkipped(false);
      setHelpOpen(false);
      setHelpOpenedOnce(false);
      setDeliveredAssistance("none");
      setAssistance("unknown");
      await refreshDeliveredAssistance(next.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法开始练习"); }
    finally { setPending(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attempt || pending) return;
    setPending(true); setError("");
    const nextAssistance = raiseAssistanceOnly(assistance, deliveredAssistance);
    const fingerprint = JSON.stringify([attempt.id, answer, outcome, nextAssistance]);
    if (submitRequest.current?.fingerprint !== fingerprint) {
      submitRequest.current = { fingerprint, clientKey: `answer-${crypto.randomUUID()}` };
    }
    try {
      const result = await client.submitAttempt(
        attempt.id,
        withRetestSubmit(
          {
            clientKey: submitRequest.current.clientKey,
            answer,
            outcome,
            assistance: nextAssistance,
            verdictSource: "self_report",
          },
          retest?.retestId,
        ),
      );
      setRecorded(result);
      setAssistance(result.assistance);
      setHelpOpen(false);
      setHelpOpenedOnce(false);
      onRecorded();
    } catch (reason) { setError(formatRetestSubmitError(reason)); }
    finally { setPending(false); }
  }

  async function repeatProblem() {
    if (!attempt?.problemId || pending) return;
    setPending(true); setError("");
    repeatKey.current ??= `attempt-${crypto.randomUUID()}`;
    try {
      const next = await client.createAttempt({
        sessionId: attempt.sessionId,
        problemId: attempt.problemId,
        requirementKey: attempt.requirementKey,
        clientKey: repeatKey.current,
      });
      setAttempt(next);
      setRecorded(null);
      setReferenceChecked(false);
      setReferenceSkipped(false);
      setAnswer("");
      setOutcome("unverified");
      setAssistance("unknown");
      setDeliveredAssistance("none");
      setHelpOpen(false);
      setHelpOpenedOnce(false);
      submitRequest.current = null;
      repeatKey.current = null;
      await refreshDeliveredAssistance(next.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法重新开始本题"); }
    finally { setPending(false); }
  }

  function reset() {
    setAttempt(null);
    setRecorded(null);
    setReferenceChecked(false);
    setReferenceSkipped(false);
    setAnswer("");
    setOutcome("unverified");
    setAssistance("unknown");
    setDeliveredAssistance("none");
    setHelpOpen(false);
    setHelpOpenedOnce(false);
    setStem(retest?.prompt ?? "");
    startRequest.current = null;
    submitRequest.current = null;
    repeatKey.current = null;
  }

  return (
    <div className="space-y-3 border-t border-zinc-200 pt-4">
      <h3 className="text-sm font-semibold text-zinc-800">记录一次练习</h3>
      {!attempt ? (
        <form onSubmit={start} className="space-y-3">
          {retest ? (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900" role="status">
              补测作答：将携带补测编号提交；完成后由服务器把对应任务标为已完成。
            </p>
          ) : null}
          {retest?.recommendedAt && new Date(retest.recommendedAt).getTime() > Date.now() ? (
            <p className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-6 text-sky-900" role="status">
              建议最早作答时间尚未到达。仍可提交，但服务器会拒收过早的补测结果。
            </p>
          ) : null}
          {retest?.prompt ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-zinc-600">补测提示</p>
              <p className="whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm leading-6 text-zinc-800">{retest.prompt}</p>
            </div>
          ) : null}
          <label className="block text-sm text-zinc-800">
            技能或练习主题
            <input
              required
              maxLength={200}
              list={skillListId}
              value={skillLabel}
              disabled={pending || Boolean(retest)}
              onChange={(event) => setSkillLabel(event.target.value)}
              className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2"
            />
          </label>
          <datalist id={skillListId}>
            {skillOptions.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          {skillReuseHint ? (
            <p className="text-xs leading-6 text-amber-800" role="status">
              与已有技能「{skillReuseHint}」仅空白/全半角/大小写不同。建议复用该名称以便摘要归并；不会自动改写你的输入。
              <button
                type="button"
                className="ml-2 font-medium text-emerald-800 underline"
                onClick={() => setSkillLabel(skillReuseHint)}
              >
                使用「{skillReuseHint}」
              </button>
            </p>
          ) : null}
          <label className="block text-sm text-zinc-800">
            题目来源（可选）
            <select
              value={sourceId}
              disabled={pending}
              onChange={(event) => setSourceId(event.target.value)}
              className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2"
            >
              <option value="">不关联题目材料，保留为待核验记录</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-zinc-800">
            答案/解析来源（可选）
            <select
              value={referenceSourceId}
              disabled={pending}
              onChange={(event) => setReferenceSourceId(event.target.value)}
              className="mt-1 w-full rounded border border-zinc-200 bg-white px-3 py-2"
            >
              <option value="">暂不绑定参考；提交后无自对照步骤</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-zinc-800">
            本次题干（可选）
            <textarea
              maxLength={2000}
              value={stem}
              disabled={pending || Boolean(retest?.prompt)}
              onChange={(event) => setStem(event.target.value)}
              className="mt-1 min-h-20 w-full rounded border border-zinc-200 bg-white px-3 py-2"
            />
          </label>
          {!stem.trim() ? (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900" role="status">
              题干为空时不会生成补测提议；隔天重做需要可复用的题干快照。
            </p>
          ) : null}
          {sourceId && !stem.trim() ? (
            <p className="text-xs text-zinc-500">已选题干来源但未填写题干时，不会创建可核验题目身份。</p>
          ) : null}
          <p className="text-xs text-zinc-500">开始时由服务器记录题目、材料版本和时间；没有题目或版本的记录仍可保存，资格为待核验。</p>
          <button
            disabled={pending || !skillLabel.trim() || (!!sourceId && !stem.trim())}
            className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {pending ? "正在开始…" : retest ? "开始补测作答" : "开始本次练习"}
          </button>
        </form>
      ) : recorded ? (
        <div className="space-y-3" role="status">
          <p className="text-sm text-zinc-800">
            已保存原答案。自报结果：{OUTCOME_LABEL[recorded.outcome]}
            {recorded.verdictSource === "reference_checked" ? " · 自对照参考" : "（尚未完成参考核对）"}。
          </p>
          <p className="text-xs text-zinc-500">自报正确不等于已核验正确；原始答案与资格分开保留。不显示掌握或稳固。</p>
          {recorded.eligibility ? <LearningEvidenceEligibilityDetails eligibility={recorded.eligibility} /> : <p className="text-xs text-zinc-500">资格待核验。</p>}
          {canReferenceCheck ? (
            <ReferenceCheckStep
              observation={recorded}
              referenceSourceId={referenceSourceId}
              referenceSourceName={referenceSource?.name}
              onChecked={(next) => {
                setRecorded(next);
                setReferenceChecked(true);
                onRecorded();
              }}
              onSkip={() => setReferenceSkipped(true)}
            />
          ) : null}
          {referenceSkipped ? (
            <p className="text-xs leading-6 text-zinc-500" role="status">已跳过参考核对，保持自报结果。</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {attempt.problemId ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => void repeatProblem()}
                className="rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-800 disabled:opacity-50"
              >
                再次练习同题（保留历史帮助）
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={reset}
              className="rounded border border-zinc-200 px-3 py-2 text-sm text-zinc-800 disabled:opacity-50"
            >
              开始其他练习
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            本次练习已开始：{attempt.skillLabel}。
            {attempt.problemId ? "题目与版本已由服务器记录。" : "未关联可核验题目，资格保持待核验。"}
            {deliveredAssistance !== "none" ? ` 会话内已送达帮助：${deliveredAssistance === "revealed" ? "看过答案或解析" : "提示"}，只能上调不能下调。` : null}
          </p>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm text-zinc-800">
              我的答案
              <textarea
                maxLength={20000}
                value={answer}
                disabled={pending}
                onChange={(event) => setAnswer(event.target.value)}
                className="mt-1 min-h-24 w-full rounded border border-zinc-200 bg-white px-3 py-2"
              />
            </label>
            <label className="block text-sm text-zinc-800">
              自报结果
              <select
                value={outcome}
                disabled={pending}
                onChange={(event) => setOutcome(event.target.value as LearningObservation["outcome"])}
                className="ml-2 rounded border border-zinc-200 bg-white px-2 py-1"
              >
                {Object.entries(OUTCOME_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-zinc-800">
              本次帮助
              <select
                value={assistance}
                disabled={pending}
                onChange={(event) => {
                  const next = event.target.value as LearningObservation["assistance"];
                  setAssistance(raiseAssistanceOnly(next, deliveredAssistance));
                }}
                className="ml-2 rounded border border-zinc-200 bg-white px-2 py-1"
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
            <button disabled={pending} className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">
              {pending ? "正在保存…" : "先保存原答案"}
            </button>
          </form>
          <button
            type="button"
            disabled={pending}
            aria-expanded={helpOpen}
            onClick={() => {
              setHelpOpenedOnce(true);
              setHelpOpen((open) => !open);
              if (attempt) void refreshDeliveredAssistance(attempt.id);
            }}
            className="text-sm text-emerald-700 underline"
          >
            {helpOpen ? "收起本次练习辅导" : "打开本次练习辅导"}
          </button>
          {helpOpenedOnce ? (
            <div className={helpOpen ? "" : "hidden"} aria-hidden={!helpOpen}>
              <AssistantView learningAttempt={attempt} />
            </div>
          ) : null}
          <p className="text-xs text-zinc-500">
            本次辅导使用保存模式，记录可取回的提示或解析；这不证明你已阅读。已记录的帮助不会因收起辅导而消失。先交原答案，再对照参考。
          </p>
        </div>
      )}
      {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    </div>
  );
}
