"use client";
import { ui } from "../design/ui";
import type { PreAnswerConfidence } from "./model";

export const confidenceOptions = [
  { value: "not_confident", label: "没把握" },
  { value: "somewhat_confident", label: "有点把握" },
  { value: "confident", label: "有把握" },
] as const satisfies readonly { value: PreAnswerConfidence; label: string }[];

/** Optional self-report before the first answer. Pressing the chosen option again clears it. */
export function ConfidenceChoice({ value, disabled, onChange, className = "" }: {
  value: PreAnswerConfidence | null; disabled: boolean; onChange: (value: PreAnswerConfidence | null) => void; className?: string;
}) {
  return <div role="group" aria-label="作答前的把握" className={`${ui.segment} ${className}`}>
    {confidenceOptions.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} disabled={disabled}
      className={`${ui.segmentItem} whitespace-nowrap disabled:pointer-events-none disabled:opacity-50`}
      onClick={() => onChange(value === option.value ? null : option.value)}>{option.label}</button>)}
  </div>;
}
