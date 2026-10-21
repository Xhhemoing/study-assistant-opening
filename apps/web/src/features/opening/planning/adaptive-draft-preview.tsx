"use client";

import type { PlanDraft, PlannedBlock, TaskFeedbackInput, TaskItem } from "@aistudy/contracts";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { secondaryButtonClass } from "../design/ui";
import { selectableSuggestedKeys } from "./daily-draft-selection";
import { SuggestionRejectionControl } from "./suggestion-rejection-control";

type Props = {
  draft: PlanDraft;
  tasks: readonly TaskItem[];
  selectedKeys: readonly string[];
  disabled: boolean;
  onSelectionChange: (keys: string[]) => void;
  onRejectSuggestion?: (key: string, reason?: TaskFeedbackInput["reason"]) => Promise<void>;
};

function titleFor(draft: PlanDraft, tasks: readonly TaskItem[], id: string): string {
  return draft.suggestedTasks?.find((task) => task.id === id)?.title
    ?? tasks.find((task) => task.id === id)?.title ?? "学习任务";
}

function reasonFor(draft: PlanDraft, block: PlannedBlock): string {
  return draft.reasons?.[block.taskId]?.label ?? block.reason;
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const UNSCHEDULED_LABELS = {
  deadline_passed: "截止时间已过",
  no_compliant_slot_after_not_before: "可开始时间之后没有合适空档",
  duration_exceeds_free_slots: "没有足够长的连续空档",
  no_slot_before_deadline: "截止前没有合适空档",
  free_time_exhausted: "可用时间已排满",
} as const;

export function AdaptiveDraftDetails({ draft, tasks, selectedKeys, disabled, onSelectionChange, onRejectSuggestion }: Props) {
  const selectable = new Set(selectableSuggestedKeys(draft));
  const suggestions = draft.suggestedTasks ?? [];
  const rejected = new Set(draft.rejectedSuggestedKeys ?? []);
  function select(key: string, checked: boolean) {
    if (disabled || !selectable.has(key)) return;
    onSelectionChange(checked ? [...new Set([...selectedKeys, key])] : selectedKeys.filter((item) => item !== key));
  }
  return <div className="space-y-3 text-xs leading-5">
    <ul className="space-y-3" aria-label="推荐安排">
      {draft.blocks.map((block) => {
        const suggestion = suggestions.find((item) => item.id === block.taskId);
        const checked = Boolean(suggestion && selectable.has(suggestion.key) && selectedKeys.includes(suggestion.key));
        const omitted = Boolean(suggestion && !checked);
        return <li key={`${block.taskId}-${block.start}`} className={omitted ? "text-text-3" : "text-text-2"}>
          {suggestion ? <label className="flex min-h-11 cursor-pointer items-start gap-2 py-2">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={checked} aria-checked={checked} disabled={disabled || !selectable.has(suggestion.key)} onChange={(event) => select(suggestion.key, event.target.checked)} />
            <span className="font-medium">{suggestion.title}</span>
          </label> : <p className="font-medium text-text">{titleFor(draft, tasks, block.taskId)}</p>}
          <p>{timeLabel(block.start)}–{timeLabel(block.end)}{rejected.has(suggestion?.key ?? "") ? " · 已反馈不适合，今天不再推荐" : omitted ? " · 不会创建" : ""}</p>
          <p>{reasonFor(draft, block)}</p>
          {suggestion && !rejected.has(suggestion.key) && onRejectSuggestion ? <SuggestionRejectionControl key={`${draft.id}:${draft.version}:${suggestion.key}`} disabled={disabled}
            onConfirm={reason => onRejectSuggestion(suggestion.key, reason)} /> : null}
        </li>;
      })}
    </ul>
    {suggestions.filter((suggestion) => !draft.blocks.some(block => block.taskId === suggestion.id)).map((suggestion) => {
      const reason = draft.unscheduled?.find((item) => item.taskId === suggestion.id)?.reason;
      return <div key={suggestion.key} className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-warn">
        <label className="flex min-h-11 cursor-pointer items-start gap-2 py-2"><input type="checkbox" className="mt-1 h-4 w-4" checked={false} aria-checked={false} disabled /><span>{suggestion.title}</span></label>
        <p>{rejected.has(suggestion.key) ? "已反馈不适合，今天不再推荐" : `今天放不下 · ${reason ? UNSCHEDULED_LABELS[reason] : "暂未排入可用时段"}`}</p>
        {!rejected.has(suggestion.key) && onRejectSuggestion ? <SuggestionRejectionControl key={`${draft.id}:${draft.version}:${suggestion.key}`} disabled={disabled}
          onConfirm={feedbackReason => onRejectSuggestion(suggestion.key, feedbackReason)} /> : null}
      </div>;
    })}
    {draft.strategyVersion ? <p className="text-xs text-text-3">安排策略：{draft.strategyVersion}</p> : null}
  </div>;
}

export function AdaptiveDraftPreview(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const selectable = new Set(selectableSuggestedKeys(props.draft));
  const next = props.draft.blocks.find((block) => {
    const suggestion = props.draft.suggestedTasks?.find((item) => item.id === block.taskId);
    return !suggestion || (selectable.has(suggestion.key) && props.selectedKeys.includes(suggestion.key));
  });
  const detailsId = `daily-draft-details-${props.draft.id}`;
  return <div className="space-y-2">
    {next ? <div className="text-xs leading-5"><p className="font-medium text-text">下一项：{titleFor(props.draft, props.tasks, next.taskId)}</p><p className="text-text-2">{reasonFor(props.draft, next)}</p></div>
      : <p className="text-xs leading-5 text-text-2">暂无选中的可排任务；可以展开查看或调整草案。</p>}
    <button type="button" className={secondaryButtonClass} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起安排与依据" : "查看安排与依据"}<ChevronDown size={13} aria-hidden /></button>
    {expanded ? <div id={detailsId}><AdaptiveDraftDetails {...props} /></div> : null}
  </div>;
}
