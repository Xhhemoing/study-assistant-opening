"use client";

import { useState } from "react";
import type { TaskFeedbackInput } from "@aistudy/contracts";
import { inputClass, secondaryButtonClass } from "../design/ui";

export function SuggestionRejectionControl({ disabled, onConfirm }: {
  disabled: boolean; onConfirm(reason?: TaskFeedbackInput["reason"]): Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [reason, setReason] = useState<TaskFeedbackInput["reason"] | "">("");
  if (!armed) return <button type="button" className="min-h-11 text-xs text-text-2 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    disabled={disabled} onClick={() => setArmed(true)}>不适合我</button>;
  return <div className="mt-2 space-y-2 rounded border border-line bg-surface px-3 py-2">
    <p>确认后今天不再推荐同一项；不会据此判断你的能力。</p>
    <label>原因（可不选）<select className={`${inputClass} ml-2 max-w-full`} value={reason} disabled={disabled}
      onChange={event => setReason(event.target.value as TaskFeedbackInput["reason"] | "")}>
      <option value="">不填写</option><option value="time_short">时间不够</option><option value="too_hard">太难</option>
      <option value="too_easy">太简单</option><option value="not_relevant">不适合当前目标</option>
      <option value="other">其他原因</option><option value="prefer_not_say">不愿说明</option>
    </select></label>
    <div className="flex flex-wrap gap-2"><button type="button" className={secondaryButtonClass} disabled={disabled}
      onClick={() => void onConfirm(reason || undefined)}>确认反馈</button>
      <button type="button" className={secondaryButtonClass} disabled={disabled} onClick={() => setArmed(false)}>取消</button></div>
  </div>;
}
