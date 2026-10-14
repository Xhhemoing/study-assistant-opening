"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PlanningAgentInput, PlanningAgentResult } from "@aistudy/contracts";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass } from "../design/ui";

/** A saved, explicit planning action; never mounted inside an ephemeral conversation. */
export function ChatPlanningPanel({ api, courseId }: { api: OpeningApi; courseId: string | null }) {
  const [text, setText] = useState("请结合今天的截止日期、课表和待复习内容，为我建议一个可执行的学习安排。");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<PlanningAgentResult | null>(null);
  const [notice, setNotice] = useState("");
  const intent = useRef<PlanningAgentInput | null>(null);
  const controller = useRef<AbortController | null>(null);
  const decision = useRef<{ id: string; action: "accept" | "reject" } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function plan(retry = false) {
    if (busy || !text.trim()) return;
    if (!retry || !intent.current) intent.current = { text, courseId, clientKey: `plan-chat:${crypto.randomUUID()}` };
    setBusy(true); setError(""); setNotice("");
    const abort = new AbortController(); controller.current = abort;
    try {
      const next = await api.planWithAgent(intent.current, abort.signal);
      setResult(next); decision.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "规划未完成，正式计划未修改。"); }
    finally { setBusy(false); }
  }
  async function decide(action: "accept" | "reject") {
    const draft = result?.draft;
    if (!draft || busy || (decision.current && decision.current.action !== action)) return;
    decision.current ??= { id: draft.id, action };
    setBusy(true); setError("");
    try {
      // Stable key across uncertain HTTP responses and component remounts.
      const next = action === "accept"
        ? await api.acceptPlan({ draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `agent-plan-accept:${draft.id}` })
        : await api.rejectPlan(draft.id);
      setResult(current => current ? { ...current, draft: next } : null);
      setNotice(action === "accept" ? "计划已确认。学习记录与掌握判断未被改写。" : "已拒绝草稿，原计划保持不变。");
      decision.current = null;
    } catch (reason) {
      if (reason instanceof OpeningApiError && reason.status === 409) decision.current = null;
      setError(reason instanceof Error ? reason.message : "结果尚未确认，请重试原操作。");
    }
    finally { setBusy(false); }
  }
  const draft = result?.draft;
  const title = (id: string) => result?.tasks.find(t => t.id === id)?.title ?? "学习任务";
  const time = (iso: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: result?.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return <details className="mx-5 mb-2 max-h-96 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3">
    <summary className="cursor-pointer text-sm font-medium text-zinc-800">用 AI 规划今日 · 提议后确认</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-5 text-zinc-600">读取本工作区任务、课表、已确认记忆{courseId ? "和当前课程学习摘要" : "；未绑定课程时不读取其他课程学习记录"}。此规划会保存，不会自动接受计划或修改截止日期。</p>
      <label className="block space-y-1 text-xs text-zinc-700"><span>本次学习安排的要求</span>
        <textarea value={text} maxLength={2000} disabled={busy} onChange={event => setText(event.target.value)} rows={2} className="w-full rounded border border-zinc-300 bg-white p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy || !text.trim() || Boolean(decision.current)} onClick={() => void plan()} type="button">{busy ? "正在处理…" : "生成学习计划草稿"}</button>
        {busy ? <button className={secondaryButtonClass} type="button" onClick={() => controller.current?.abort()}>停止等待</button> : null}
        {error && intent.current && !decision.current ? <button className={secondaryButtonClass} type="button" disabled={busy} onClick={() => void plan(true)}>读取同次请求结果</button> : null}
      </div>
      <p className="text-xs text-zinc-500"><Link className="underline" href="/settings#planning">设置可用时间和 AI</Link> · <Link className="underline" href="/opening/library">从笔记或材料开始</Link></p>
      {error ? <p role="alert" className="text-xs leading-5 text-red-700">{error} 网络中断不代表模型未计费；读取同次请求不会重发已计费步骤。原确认操作结果不明时只能重试原操作。</p> : null}
      {result ? <div className="space-y-2" aria-live="polite">
        <p className="text-xs font-medium text-zinc-700">AI 建议 · {draft?.status === "accepted" ? "已确认" : draft?.status === "rejected" ? "已拒绝" : "未执行"}</p>
        <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">{result.message}</p>
        {draft ? <>
          <p className="text-xs text-zinc-500">{draft.date} · {result.timeZone} · 草稿两分钟内有效，超时或任务变化需重新规划。</p>
          <ol className="space-y-1 text-sm text-zinc-800">{draft.blocks.map((b, i) => <li key={`${b.taskId}:${i}`}>{time(b.start)}–{time(b.end)} {title(b.taskId)}</li>)}</ol>
          {draft.unscheduledTaskIds.length ? <p className="text-xs text-amber-800">未排入：{draft.unscheduledTaskIds.map(title).join("、")}。任务仍保留，截止日期未改动。</p> : null}
          {draft.status === "draft" ? <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy || decision.current?.action === "reject"} onClick={() => void decide("accept")}>确认此计划</button>
            <button type="button" className={secondaryButtonClass} disabled={busy || decision.current?.action === "accept"} onClick={() => void decide("reject")}>拒绝草稿</button>
          </div> : <Link className={secondaryButtonClass} href="/opening/today">查看今日学习</Link>}
        </> : null}
      </div> : null}
      {notice ? <p role="status" className="text-xs text-emerald-800">{notice}</p> : null}
    </div>
  </details>;
}
