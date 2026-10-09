"use client";

import { useRef, useState, type FormEvent } from "react";
import type { LearningObservation } from "@aistudy/contracts";
import { createOpeningLearningClient } from "../client/learning-client";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import {
  buildSelfCompareRevision,
  referenceCheckFailure,
  selfCompareRevisionIntentKey,
  type SelfCompareChoice,
} from "./reference-check";

const CHOICE_LABEL: Record<Exclude<SelfCompareChoice, "unclear">, string> = {
  match: "全部一致",
  partial: "部分一致",
  mismatch: "不一致",
};

type Props = {
  observation: LearningObservation;
  referenceSourceId: string;
  referenceSourceName?: string;
  onChecked: (observation: LearningObservation) => void;
  onSkip: () => void;
};

/**
 * Step 2: learner compares the locked original answer against a session-bound reference.
 * Server rejects answer changes when referenceCheck is present; UI locks the field.
 */
export function ReferenceCheckStep({
  observation,
  referenceSourceId,
  referenceSourceName,
  onChecked,
  onSkip,
}: Props) {
  const client = createOpeningLearningClient();
  const [choice, setChoice] = useState<SelfCompareChoice | "">("");
  const [page, setPage] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [done, setDone] = useState<LearningObservation | null>(null);
  const retry = useRef<{ intent: string; clientKey: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!choice || choice === "unclear" || pending) return;
    setPending(true);
    setMessage("");
    setConflict(false);
    const pageNumber = page.trim() ? Number.parseInt(page.trim(), 10) : null;
    const pageArg = pageNumber != null && Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null;
    const intent = selfCompareRevisionIntentKey(observation.id, choice, pageArg);
    if (retry.current?.intent !== intent) {
      retry.current = { intent, clientKey: `self-compare-${crypto.randomUUID()}` };
    }
    const command = buildSelfCompareRevision({
      observation,
      referenceSourceId,
      choice,
      page: pageArg,
      clientKey: retry.current.clientKey,
    });
    if (!command) {
      setPending(false);
      return;
    }
    try {
      const result = await client.reviseObservation(command);
      const next = result.observation;
      if (!next) throw new Error("对照参考核对未返回观察，请重新读取。");
      setDone(next);
      retry.current = null;
      onChecked(next);
    } catch (error) {
      const failure = referenceCheckFailure(error);
      setMessage(failure.message);
      if (failure.kind === "conflict") setConflict(true);
    } finally {
      setPending(false);
    }
  }

  function skipUnclear() {
    setChoice("unclear");
    setMessage("已保留原自报结果，未写入参考核对。");
    onSkip();
  }

  if (done) {
    return (
      <div className="space-y-2 rounded border border-emerald-200 bg-emerald-50/40 px-3 py-3" role="status">
        <p className="text-sm text-zinc-800">已完成自对照参考核对。</p>
        <p className="text-xs text-zinc-500">答案未改动；判定来源为参考核对（自对照参考），不表示掌握或稳固。</p>
        {done.eligibility ? <LearningEvidenceEligibilityDetails eligibility={done.eligibility} /> : null}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded border border-zinc-200 bg-zinc-50/60 px-3 py-3">
      <div>
        <h4 className="text-sm font-semibold text-zinc-800">自对照参考</h4>
        <p className="mt-1 text-xs leading-6 text-zinc-500">
          先打开会话绑定的参考来源整体对照；答案已锁定，不能在核对时改写。
          {referenceSourceName ? ` 参考材料：${referenceSourceName}。` : null}
        </p>
      </div>
      <label className="block text-sm text-zinc-800">
        我的答案（已锁定）
        <textarea
          readOnly
          value={observation.answer}
          className="mt-1 min-h-20 w-full cursor-not-allowed rounded border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-700"
        />
      </label>
      <fieldset className="space-y-2" disabled={pending}>
        <legend className="text-sm text-zinc-800">对照结果</legend>
        {(Object.keys(CHOICE_LABEL) as Array<keyof typeof CHOICE_LABEL>).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm text-zinc-800">
            <input
              type="radio"
              name="self-compare-choice"
              value={value}
              checked={choice === value}
              onChange={() => setChoice(value)}
            />
            {CHOICE_LABEL[value]}
          </label>
        ))}
      </fieldset>
      <label className="block text-sm text-zinc-800">
        参考页码（可选）
        <input
          type="number"
          min={1}
          step={1}
          value={page}
          disabled={pending}
          onChange={(event) => setPage(event.target.value)}
          className="mt-1 w-28 rounded border border-zinc-200 bg-white px-3 py-2 text-sm"
          placeholder="如 3"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending || !choice || choice === "unclear"}
          className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? "正在保存核对…" : "提交对照结果"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={skipUnclear}
          className="rounded border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 disabled:opacity-50"
        >
          看不懂参考
        </button>
      </div>
      {conflict ? (
        <p className="text-xs leading-6 text-amber-800" role="status">
          {message} 请刷新课程记录后重试；本次输入的对照选项仍可重新提交。
        </p>
      ) : message ? (
        <p className="text-sm text-red-700" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
