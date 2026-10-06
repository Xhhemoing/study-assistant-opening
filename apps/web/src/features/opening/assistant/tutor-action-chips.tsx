"use client";

import { Sparkles } from "lucide-react";
import type { ThinTutorActionView } from "../client/api";
import { TUTOR_ACTION_KIND_LABEL, tutorActionIntent, type TutorActionIntent } from "../learning/tutor-action-intents";

type Props = {
  actions: ThinTutorActionView[];
  disabled?: boolean;
  pending?: boolean;
  onAction: (intent: TutorActionIntent) => void;
};

/**
 * LAB-U01 action chips: pure presentation of server-derived recommendations.
 * A click maps to one intent; all writes stay with the parent handlers
 * (composer prefill, L02 accept flow). No progress denominator, no mastery.
 */
export function TutorActionChips({ actions, disabled = false, pending = false, onAction }: Props) {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1 pt-2 sm:px-5" role="group" aria-label="推荐的下一步">
      <Sparkles size={13} aria-hidden className="text-emerald-700" />
      <span className="text-[11px] font-medium text-zinc-500">下一步建议</span>
      {actions.map((actionItem) => (
        <button
          key={`${actionItem.kind}:${actionItem.problemRef ?? ""}`}
          type="button"
          disabled={disabled || pending}
          title={actionItem.reason}
          className="max-w-full truncate rounded-full border border-emerald-200 bg-emerald-50/70 px-3 py-1.5 text-xs font-medium text-emerald-900 transition-[background-color,border-color] duration-150 hover:border-emerald-300 hover:bg-emerald-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          onClick={() => onAction(tutorActionIntent(actionItem))}
        >
          {TUTOR_ACTION_KIND_LABEL[actionItem.kind]}
        </button>
      ))}
    </div>
  );
}
