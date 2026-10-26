"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { AssistantProposalRecord, AssistantProposalTool } from "@aistudy/contracts";
import type { ProposalPanelModel } from "./use-proposal-panel";
import { buttonClass, secondaryButtonClass } from "../design/ui";

const labels: Record<AssistantProposalTool["name"], string> = {
  propose_teaching_move: "安排一次讲解", propose_plan_change: "调整学习计划", propose_card: "整理成卡片",
  propose_note: "整理成笔记", propose_memory: "记住学习偏好", flag_dispute: "复核这次判分",
};
function proposalText(row: AssistantProposalRecord): string {
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
/** Presentation only: responsive placement never owns requests or form state. */
export function ProposalPanel({ model, objectHref = href => href, draftsOnly = false }: { model: ProposalPanelModel; objectHref?: (href: string) => string; draftsOnly?: boolean }) {
  const { rows, observations, kind, setKind, text, setText, title, setTitle, back, setBack, date, setDate,
    observationId, setObservationId, busy, loading, readError, observationError, message, refresh, sourceTurnId, courseId, propose, decide } = model;
  const visibleRows = draftsOnly ? rows.filter(row => row.status === "draft") : rows;
  const field = "w-full rounded-md border border-text-3 bg-surface px-3 py-2 text-sm focus-visible:outline-accent";
  const needsObservation = kind === "propose_card" || kind === "flag_dispute";
  return <section aria-label="学习建议" className="space-y-3 pt-3">
    <p className="text-xs leading-5 text-text-2">这些是根据对话给出的建议，你点了接受才会生效。</p>
    {message ? <p role="status" className="text-sm text-warn">{message}</p> : null}
    {loading ? <p role="status" className="text-xs text-text-2">正在读取建议…</p> : null}
    {readError ? <p role="alert" className="text-sm text-warn">{readError}</p> : null}
    {observationError ? <p role="alert" className="text-sm text-warn">作答记录暂时无法读取：{observationError}</p> : null}
    <button type="button" className={secondaryButtonClass} disabled={busy || loading} onClick={() => { void refresh(); }}>重新读取建议</button>
    {sourceTurnId ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void propose(); }}>
      <label className="block text-sm">下一步想做什么<select className={field} value={kind} disabled={busy} onChange={event => setKind(event.target.value as typeof kind)}>{Object.entries(labels).filter(([name]) => courseId || (name !== "propose_plan_change" && name !== "flag_dispute")).map(([name, label]) => <option key={name} value={name}>{label}</option>)}</select></label>
      {needsObservation ? <label className="block text-sm">关联作答<select required value={observationId} className={field} disabled={busy} onChange={event => setObservationId(event.target.value)}><option value="">选择一次作答</option>{observations.map(row => <option key={row.id} value={row.id}>{row.skillLabel} · {new Date(row.occurredAt).toLocaleString("zh-CN")}</option>)}</select></label> : null}
      {kind === "propose_note" ? <label className="block text-sm">笔记标题<input required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} className={field} disabled={busy} /></label> : null}
      {kind === "propose_plan_change" ? <label className="block text-sm">安排日期<input required type="date" value={date} onChange={event => setDate(event.target.value)} className={field} disabled={busy} /></label> : <label className="block text-sm">{kind === "flag_dispute" ? "需要复核的原因" : kind === "propose_card" ? "卡片问题" : "具体内容"}<textarea required rows={3} maxLength={kind === "propose_note" ? 20000 : 2000} value={text} onChange={event => setText(event.target.value)} className={field} disabled={busy} /></label>}
      {kind === "propose_card" ? <label className="block text-sm">卡片答案<textarea required rows={3} maxLength={4000} value={back} onChange={event => setBack(event.target.value)} className={field} disabled={busy} /></label> : null}
      <button className={buttonClass} disabled={busy || (needsObservation && !observations.length) || (kind === "propose_teaching_move" && !courseId)} type="submit">准备建议</button>
    </form> : null}
    <ul className="space-y-3">{visibleRows.map(row => <li key={row.id} className="border-t border-line pt-3">
      <h3 className="text-sm font-semibold">{labels[row.tool.name]}</h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{proposalText(row)}</p>
      {row.tool.name === "propose_plan_change" ? <PlanProposalPreview row={row} /> : null}
      {row.status === "draft" ? <div className="mt-2 flex gap-2"><button className={buttonClass} disabled={busy || (row.tool.name === "propose_plan_change" && !row.prepared?.preview)} onClick={() => void decide(row, "accept")}>接受</button><button className={secondaryButtonClass} disabled={busy} onClick={() => void decide(row, "reject")}>不采用</button></div> : <p className="mt-2 text-xs text-text-3">{row.status === "accepted" ? "已接受" : "未采用"}</p>}
      {row.result?.href.startsWith("/") && !row.result.href.startsWith("//") ? <Link href={objectHref(row.result.href)} className={`${secondaryButtonClass} mt-2`}>查看结果</Link> : null}
    </li>)}</ul>
  </section>;
}
