"use client";

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
    <section className="space-y-5 border-t border-line pt-6" aria-labelledby="verdict-heading" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 inline-grid size-9 shrink-0 place-items-center rounded-full ${correct ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
          {correct ? <CheckCircle2 aria-hidden="true" size={19} /> : <TriangleAlert aria-hidden="true" size={19} />}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-text" id="verdict-heading">{correct ? "回答正确" : "还差一点"}</h2>
          <p className="text-sm text-text-dim">{correct ? "这次作答可以作为学习证据提交。" : "先记录你认为最主要的卡点，再继续调整。"}</p>
        </div>
      </div>

      {showAnswer ? <p className="border-y border-line py-3 text-sm leading-6 text-text"><span className="font-semibold">参考答案：</span>{expectedAnswer}</p> : <button className="min-h-10 rounded-md border border-line px-3 text-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={submitting} onClick={onRevealAnswer} type="button">查看参考答案</button>}
      {assisted ? <p className="text-xs text-warning">看过答案，本次不计入有效独立证据。</p> : null}

      <fieldset className="grid gap-3" disabled={submitting}>
        <legend className="text-sm font-semibold text-text">这次作答有多大把握？</legend>
        <div className="grid grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((value) => (
            <label className={`grid min-h-11 cursor-pointer place-items-center rounded-md border text-sm transition-colors ${confidence === value ? "border-primary bg-primary/10 text-primary" : "border-line text-text-dim hover:bg-surface-2 hover:text-text"}`} key={value}>
              <input className="sr-only" checked={confidence === value} name="practice-confidence" onChange={() => onConfidenceChange(value)} type="radio" value={value} />
              {value}
            </label>
          ))}
        </div>
      </fieldset>

      {!correct ? <label className="grid gap-2" htmlFor="practice-error-cause"><span className="text-sm font-semibold text-text">主要卡点</span><select className="min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60" disabled={submitting} id="practice-error-cause" onChange={(event) => onErrorCauseChange(event.target.value as ErrorCause)} value={errorCause ?? ""}><option value="">请选择</option>{errorCauses.map((cause) => <option key={cause.value} value={cause.value}>{cause.label}</option>)}</select></label> : null}

      {issue && issueMessages[issue] ? <p className="text-sm text-danger" role="alert">{issueMessages[issue]}</p> : null}
      <button className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-ink transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" disabled={submitting} onClick={onSubmit} type="button">
        {submitting ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <Send aria-hidden="true" size={16} />}
        {submitting ? "提交中" : "提交这次作答"}
      </button>
    </section>
  );
}
