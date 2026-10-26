"use client";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { AssistantProposalRecord, AssistantProposalTool } from "@aistudy/contracts";
import { secondaryButtonClass } from "../design/ui";
import type { PendingProposalsState } from "./use-pending-proposals";

export const proposalLabels: Record<AssistantProposalTool["name"], string> = {
  propose_teaching_move: "安排一次讲解", propose_plan_change: "调整学习计划", propose_card: "整理成卡片",
  propose_note: "整理成笔记", propose_memory: "记住学习偏好", flag_dispute: "复核这次判分",
};
export function proposalText(row: AssistantProposalRecord): string {
  const tool = row.tool;
  switch (tool.name) {
    case "propose_teaching_move": return tool.arguments.topic;
    case "propose_plan_change": return `${tool.arguments.date} 的学习安排；接受时再次核对计划与学习状态。`;
    case "propose_card": return `${tool.arguments.front}\n答案：${tool.arguments.back}`;
    case "propose_note": return `${tool.arguments.title}\n${tool.arguments.text}`;
    case "propose_memory": return tool.arguments.text;
    case "flag_dispute": return `${tool.arguments.reason}（接受后保留原记录，将该次结果标为待核对。）`;
  }
}
export function PlanProposalPreview({ row }: { row: AssistantProposalRecord }) {
  const preview = row.prepared?.preview;
  if (!preview) return <p className="text-sm text-warn">计划预览不可用，请重新准备建议后再确认。</p>;
  const titles = new Map(preview.tasks.map(task => [task.id, task.title]));
  const taskIds = [...new Set([...preview.previousBlocks.map(block => block.taskId), ...preview.proposedBlocks.map(block => block.taskId)])];
  const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: preview.timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const spans = (blocks: typeof preview.previousBlocks, id: string) => blocks.filter(block => block.taskId === id).map(block => `${time(block.start)} 至 ${time(block.end)}`).join("；");
  return <section aria-label="计划变更预览" className="mt-2 space-y-2 rounded-lg border border-line bg-surface-2 p-3">
    <p className="text-xs text-text-2">具体调整 · {preview.timeZone}</p>
    {taskIds.length ? <ul className="space-y-2">{taskIds.map(id => {
      const before = spans(preview.previousBlocks, id), after = spans(preview.proposedBlocks, id);
      const label = before === after ? "保留" : before && after ? "调整" : after ? "新增" : "移出安排";
      return <li key={id} className="text-sm leading-6"><p className="font-medium">{titles.get(id) ?? "已不可用的学习任务"} · {label}</p>
        <p className="text-text-2">原安排：{before || "未安排"}</p><p>建议安排：{after || "未安排"}</p></li>;
    })}</ul> : <p className="text-sm">本次建议没有安排学习时段。</p>}
    <p className="text-xs font-medium">尚未排入：{preview.unscheduledTaskIds.length ? preview.unscheduledTaskIds.map(id => titles.get(id) ?? "已不可用的学习任务").join("、") : "无"}</p>
  </section>;
}
/** The conversation surface only previews suggestions; the inbox owns decisions. */
export function ProposalPanel({ state }: { state: PendingProposalsState }) {
  return <section aria-label="当前对话的学习建议" className="space-y-3 pt-3">
    {state.error ? <p role="alert" className="text-sm text-warn">{state.error}</p> : null}
    {state.loading ? <p role="status" className="text-xs text-text-2">正在读取建议…</p> : null}
    {state.error ? <button className={secondaryButtonClass} onClick={() => void state.refresh()}>重新读取建议</button> : null}
    <ul className="space-y-3">{state.rows.map(row => <li key={row.id} className="border-t border-line pt-3">
      <h3 className="text-sm font-semibold">{proposalLabels[row.tool.name]}</h3>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{proposalText(row)}</p>
    </li>)}</ul>
    {state.cursor ? <button className={secondaryButtonClass} disabled={state.loading} onClick={() => void state.loadMore()}>读取更多建议</button> : null}
    {!state.error && !state.loading && !state.rows.length ? <p className="text-xs text-text-2">当前对话暂无待确认建议。</p> : null}
    <Link href="/opening/suggestions" className={secondaryButtonClass}>前往建议收件箱{state.total ? ` · 本对话 ${state.total} 项` : ""}</Link>
  </section>;
}
