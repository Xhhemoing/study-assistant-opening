"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { AssistantProposalCreate, AssistantProposalRecord, AssistantProposalTool, LearningObservation } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { createOpeningLearningClient } from "../client/learning-client";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

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
const localDate = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

/** Suggestions stay reviewable drafts. Each retry keeps its original intent key. */
export function ProposalPanel({ api, sourceTurnId, courseId, refreshKey, objectHref = href => href }: { objectHref?: (href: string) => string; api: OpeningApi; sourceTurnId: string | null; courseId: string | null; refreshKey?: string }) {
  const learning = useMemo(() => createOpeningLearningClient(), []);
  const [rows, setRows] = useState<AssistantProposalRecord[]>([]);
  const [observations, setObservations] = useState<LearningObservation[]>([]);
  const [kind, setKind] = useState<AssistantProposalTool["name"]>("propose_note");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [back, setBack] = useState("");
  const [date, setDate] = useState(localDate);
  const [observationId, setObservationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<{ fingerprint: string; input: AssistantProposalCreate } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const proposals = await api.listAssistantProposals();
    const facts = courseId ? await learning.listObservations(courseId) : [];
    if (current === generation.current) { setRows(proposals); setObservations(facts); }
  }, [api, courseId, learning]);
  useEffect(() => { void refresh().catch(error => setMessage(userFacingMessage(error, "建议暂时无法读取"))); return () => { generation.current++; }; }, [refresh, refreshKey, sourceTurnId]);

  async function propose() {
    if (!sourceTurnId) return;
    setBusy(true); setMessage("");
    try {
      const observation = observations.find(row => row.id === observationId);
      let tool: AssistantProposalTool;
      switch (kind) {
        case "propose_teaching_move":
          if (!courseId) throw new Error("请从课程进入助理后安排讲解。");
          tool = { name: kind, arguments: { courseId, topic: text } }; break;
        case "propose_plan_change": {
          const current = await api.getToday(date);
          tool = { name: kind, arguments: { date, expectedAcceptedVersion: current.acceptedVersion } }; break;
        }
        case "propose_card":
          if (!observation) throw new Error("请选择要整理的真实作答。");
          tool = { name: kind, arguments: { observationId: observation.id, front: text, back } }; break;
        case "propose_note": tool = { name: kind, arguments: { title, text } }; break;
        case "propose_memory": tool = { name: kind, arguments: { text, courseId } }; break;
        case "flag_dispute":
          if (!observation) throw new Error("请选择需要复核的真实作答。");
          tool = { name: kind, arguments: { rootObservationId: observation.rootObservationId ?? observation.id, expectedHead: observation.effectiveHeadId ?? observation.id, reason: text } }; break;
      }
      const fingerprint = JSON.stringify({ sourceTurnId, tool });
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, input: { sourceTurnId, tool, clientKey: `assistant-proposal:${crypto.randomUUID()}` } };
      await api.proposeAssistantAction(pending.current.input);
      pending.current = null;
      setMessage("建议已准备好，请检查内容后接受。");
      await refresh();
    } catch (error) { setMessage(userFacingMessage(error, "暂时无法确认建议是否已保存；重新读取后可重试同一内容。")); }
    finally { setBusy(false); }
  }
  async function decide(row: AssistantProposalRecord, action: "accept" | "reject") {
    setBusy(true); setMessage("");
    try {
      await api.decideAssistantProposal(row.id, { expectedVersion: row.version, action, clientKey: `proposal-decision:${row.id}:${row.version}:${action}` });
      await refresh();
    } catch (error) { setMessage(userFacingMessage(error, "结果未确认，请重新读取后再操作。")); }
    finally { setBusy(false); }
  }
  const field = "w-full rounded-md border border-text-3 bg-surface px-3 py-2 text-sm focus-visible:outline-accent";
  const needsObservation = kind === "propose_card" || kind === "flag_dispute";
  return <section aria-label="学习建议" className="space-y-3 pt-3">
    <p className="text-xs leading-5 text-text-2">先检查并修改建议，接受后才更新学习安排、笔记或偏好。</p>
    {message ? <p role="status" className="text-sm text-warn">{message}</p> : null}
    <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => { void refresh().catch(error => setMessage(String(error))); }}>重新读取建议</button>
    {sourceTurnId ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void propose(); }}>
      <label className="block text-sm">下一步想做什么<select className={field} value={kind} disabled={busy} onChange={event => setKind(event.target.value as typeof kind)}>{Object.entries(labels).map(([name, label]) => <option key={name} value={name}>{label}</option>)}</select></label>
      {needsObservation ? <label className="block text-sm">关联作答<select required value={observationId} className={field} disabled={busy} onChange={event => setObservationId(event.target.value)}><option value="">选择一次作答</option>{observations.map(row => <option key={row.id} value={row.id}>{row.skillLabel} · {new Date(row.occurredAt).toLocaleString("zh-CN")}</option>)}</select></label> : null}
      {kind === "propose_note" ? <label className="block text-sm">笔记标题<input required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} className={field} disabled={busy} /></label> : null}
      {kind === "propose_plan_change" ? <label className="block text-sm">安排日期<input required type="date" value={date} onChange={event => setDate(event.target.value)} className={field} disabled={busy} /></label> : <label className="block text-sm">{kind === "flag_dispute" ? "需要复核的原因" : kind === "propose_card" ? "卡片问题" : "具体内容"}<textarea required rows={3} maxLength={kind === "propose_note" ? 20000 : 2000} value={text} onChange={event => setText(event.target.value)} className={field} disabled={busy} /></label>}
      {kind === "propose_card" ? <label className="block text-sm">卡片答案<textarea required rows={3} maxLength={4000} value={back} onChange={event => setBack(event.target.value)} className={field} disabled={busy} /></label> : null}
      <button className={buttonClass} disabled={busy || (needsObservation && !observations.length) || (kind === "propose_teaching_move" && !courseId)} type="submit">准备建议</button>
    </form> : <p className="text-xs text-text-3">先完成一轮保存对话，即可准备关联这次问题的建议。</p>}
    <ul className="space-y-3">{rows.map(row => <li key={row.id} className="border-t border-line pt-3">
      <h3 className="text-sm font-semibold">{labels[row.tool.name]}</h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{proposalText(row)}</p>
      {row.tool.name === "propose_plan_change" ? <PlanProposalPreview row={row} /> : null}
      {row.status === "draft" ? <div className="mt-2 flex gap-2"><button className={buttonClass} disabled={busy || (row.tool.name === "propose_plan_change" && !row.prepared?.preview)} onClick={() => void decide(row, "accept")}>接受</button><button className={secondaryButtonClass} disabled={busy} onClick={() => void decide(row, "reject")}>不采用</button></div> : <p className="mt-2 text-xs text-text-3">{row.status === "accepted" ? "已接受" : "未采用"}</p>}
      {row.result?.href.startsWith("/") && !row.result.href.startsWith("//") ? <Link href={objectHref(row.result.href)} className={`${secondaryButtonClass} mt-2`}>查看结果</Link> : null}
    </li>)}</ul>
  </section>;
}
