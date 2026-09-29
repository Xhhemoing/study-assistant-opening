"use client";

import { ui } from "../opening/design/ui";
import { CheckCircle2, LoaderCircle, Send, TriangleAlert } from "lucide-react";
import type { ErrorCause } from "@aistudy/contracts";
import type { SubmissionIssue } from "./practice-player-model";

const errorCauses: Array<{ value: ErrorCause; label: string }> = [
  { value: "concept", label: "概念理解" },
  { value: "misread", label: "读题偏差" },
  { value: "calculation", label: "计算错误" },
  { value: "steps", label: "步骤遗漏" },
  { value: "time", label: "时间不足" },
  { value: "other", label: "其他原因" },
];

const issueMessages: Partial<Record<SubmissionIssue, string>> = {
  "confidence-required": "提交前请选择信心等级。",
  "error-cause-required": "答错时请选择最主要的原因。",
};

interface VerdictPanelProps {
  correct: boolean;
  assisted: boolean;
  showAnswer: boolean;
  expectedAnswer: string;
  confidence: number | null;
  errorCause: ErrorCause | null;
  issue: SubmissionIssue | null;
  submitting: boolean;
  onConfidenceChange: (confidence: number) => void;
  onErrorCauseChange: (cause: ErrorCause) => void;
  onRevealAnswer: () => void;
  onSubmit: () => void;
}

export function VerdictPanel({
  correct,
  assisted,
  showAnswer,
  expectedAnswer,
  confidence,
  errorCause,
  issue,
  submitting,
  onConfidenceChange,
  onErrorCauseChange,
  onRevealAnswer,
  onSubmit,
}: VerdictPanelProps) {
  return (
    <section className="space-y-5 border-t border-zinc-200 pt-6" aria-labelledby="verdict-heading" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 inline-grid size-10 md:size-8 shrink-0 place-items-center rounded-full ${correct ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
          {correct ? <CheckCircle2 aria-hidden="true" size={19} /> : <TriangleAlert aria-hidden="true" size={19} />}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-zinc-900" id="verdict-heading">{correct ? "回答正确" : "还差一点"}</h2>
          <p className="text-sm text-zinc-500">{correct ? "这次作答可以作为学习证据提交。" : "先记录你认为最主要的卡点，再继续调整。"}</p>
        </div>
      </div>

      {showAnswer ? <p className="border-y border-zinc-200 py-3 text-sm leading-7 text-zinc-900"><span className="font-semibold">参考答案：</span>{expectedAnswer}</p> : <button className="min-h-10 md:min-h-8 rounded-md border border-zinc-200 px-3 text-sm text-zinc-500 transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50" disabled={submitting} onClick={onRevealAnswer} type="button">查看参考答案</button>}
      {assisted ? <p className="text-xs text-amber-700">看过答案，本次不计入有效独立证据。</p> : null}

      <fieldset className="grid gap-3" disabled={submitting}>
        <legend className="text-sm font-semibold text-zinc-900">这次作答有多大把握？</legend>
        <div className="grid grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((value) => (
            <label className={`grid min-h-10 md:min-h-8 cursor-pointer place-items-center rounded-md border text-sm focus-within:ring-2 focus-within:ring-emerald-700 transition-colors duration-150 motion-reduce:transition-none ${confidence === value ? "border-emerald-600 bg-emerald-50 text-emerald-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"}`} key={value}>
              <input className="sr-only" checked={confidence === value} name="practice-confidence" onChange={() => onConfidenceChange(value)} type="radio" value={value} />
              {value}
            </label>
          ))}
        </div>
      </fieldset>

      {!correct ? <label className="grid gap-2" htmlFor="practice-error-cause"><span className="text-sm font-semibold text-zinc-900">主要卡点</span><select className="min-h-10 md:min-h-8 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:opacity-60" disabled={submitting} id="practice-error-cause" onChange={(event) => onErrorCauseChange(event.target.value as ErrorCause)} value={errorCause ?? ""}><option value="">请选择</option>{errorCauses.map((cause) => <option key={cause.value} value={cause.value}>{cause.label}</option>)}</select></label> : null}

      {issue && issueMessages[issue] ? <p className="text-sm text-red-700" role="alert">{issueMessages[issue]}</p> : null}
      <button className={`${ui.primary} w-full sm:w-auto`} disabled={submitting} onClick={onSubmit} type="button">
        {submitting ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={16} /> : <Send aria-hidden="true" size={16} />}
        {submitting ? "提交中" : "提交这次作答"}
      </button>
    </section>
  );
}
