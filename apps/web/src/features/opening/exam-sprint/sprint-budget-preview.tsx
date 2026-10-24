"use client";

import { sprintBudgetResponseSchema, type SprintBudgetResponse } from "@aistudy/contracts";
import { useEffect, useRef, useState } from "react";
import { createSessionFetch } from "../../auth/session-expiry";
import { parseOpeningResponse } from "../client/parse-response";
import { ui } from "../design/ui";

const statuses: Record<SprintBudgetResponse["status"], string> = {
  ready: "只读预估，尚未应用", needs_goal: "请先设置课程考试日期和时间预算。",
  needs_settings: "请先在时间设置中保存每天可用窗口。", invalid_settings: "保存的目标或时间设置无法核验，请检查后重试。",
  deadline_reached: "目标日期已到，不再把待办自动塞进考试当天。请先调整目标。",
};
const reasons: Record<string, string> = {
  deadline_passed: "截止时间已过，需要确认是否延期", no_compliant_slot_after_not_before: "可开始时间之后没有合适空档",
  duration_exceeds_free_slots: "没有足够长的连续空档", no_slot_before_deadline: "截止之前放不下", free_time_exhausted: "可用时间已用完",
  budget_exhausted: "课程时间预算不足", daily_budget_exceeded: "课程剩余每日预算不足", review_only_day: "考前一天保留复习，不新增学习任务",
  exam_eve_review_only: "考前一天只新增复习或复测任务", no_available_time: "没有剩余可用空档", exam_date_reached: "考试日期已到",
  no_available_day: "预测范围内没有可安排日期", exam_deadline: "考试之前无法安排", no_capacity: "没有剩余可用时间",
};
export async function readSprintBudget(courseId: string, signal: AbortSignal, request = createSessionFetch(fetch)): Promise<SprintBudgetResponse> {
  const requestedCourseId = courseId.toLowerCase();
  const response = await request(`/api/opening/courses/${encodeURIComponent(requestedCourseId)}/sprint-budget`, { method: "GET", cache: "no-store", signal });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error("冲刺预估暂时无法读取；当前正式安排没有改变。");
  const data = parseOpeningResponse(sprintBudgetResponseSchema, body);
  if (data.courseId !== requestedCourseId) throw new Error("课程已变化，请重新读取冲刺预估。");
  return data;
}

/** Explicit read only: no mount effect, polling, plan proposal or model call. */
export function SprintBudgetPreview({ courseId, load = readSprintBudget }: {
  courseId: string; load?: typeof readSprintBudget;
}) {
  const [data, setData] = useState<SprintBudgetResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.abort(); pending.current = null; setData(null); setError(""); setBusy(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [courseId]);
  async function refresh() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(""); setData(null);
    try {
      const result = await load(courseId, controller.signal);
      if (pending.current === controller && !controller.signal.aborted) setData(result);
    } catch (reason) {
      if (!controller.signal.aborted && pending.current === controller) setError(reason instanceof Error ? reason.message : "预估暂时不可用。");
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }
  const titles = new Map(data?.tasks.map(task => [task.id, task.title]));
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label="考前时间预算预估">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">这些任务考前排得下吗？</h3>
      <button type="button" className={ui.secondary} disabled={busy} onClick={() => void refresh()}>{busy ? "正在读取预估…" : data ? "重新计算时间预估" : "预估考前时间"}</button></div>
    <p className="text-xs text-text-2">仅核算已有任务，最多向前看 28 天；不会创建任务、调用模型或改动正式安排。</p>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {data ? <div className="space-y-3"><p role="status" className="text-sm text-text-2">{statuses[data.status]}</p>
      {data.status === "ready" ? <>
        <p className="text-sm">每日预算 {data.dailyMinutes} 分钟 · 新增可排 {data.scheduledTaskIds.length} 项 · 未排入 {data.unscheduled.length} 项 · 尚未到期 {data.deferredTaskIds.length} 项</p>
        {!data.tasks.length ? <p className="text-sm text-text-2">本课没有已有待办，不代表全部课程已经学会。</p> : null}
        {data.horizonTruncated ? <p className="text-sm text-warn">考试还在预测范围之外，以下并非完整考前安排。</p> : null}
        <details><summary className="cursor-pointer py-2 text-sm">逐日预估与未排入原因</summary>
          <ol className="space-y-3 text-sm">{data.days.map(day => <li key={day.date}><p>{day.date} · 已确认占用 {day.committedMinutes} 分钟 · 建议新增 {day.plannedMinutes} 分钟</p>
            <ul className="ml-4 list-disc">{day.blocks.map(block => <li key={`${block.taskId}/${block.start}`}>{titles.get(block.taskId) ?? "任务"} · {new Date(block.start).toLocaleTimeString("zh-CN", { timeZone: data.timeZone ?? "UTC", hour: "2-digit", minute: "2-digit", hour12: false })}</li>)}</ul></li>)}</ol>
          <ul className="mt-3 space-y-1 text-warn">{data.unscheduled.map(item => <li key={item.taskId}>{titles.get(item.taskId) ?? "任务"}：{reasons[item.reason] ?? "目前条件下无法排入，需要调整时间或任务。"}</li>)}</ul>
        </details>
      </> : null}
      <ul className="space-y-1 text-xs text-text-2">{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </div> : null}
  </section>;
}
