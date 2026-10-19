"use client";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import type { LearningObservation } from "@aistudy/contracts";
import { ui } from "../../design/ui";
const receiptSchema = z.object({ taskId: z.string().uuid(), notBeforeAt: z.string().datetime(), href: z.string().startsWith("/opening/courses/") });
export function SpanDelayedRetestControl({ record }: { record: LearningObservation }) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<z.infer<typeof receiptSchema> | null>(null);
  async function schedule() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/opening/teaching/span/delayed", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ observationId: record.id, clientKey: `span-delayed:${record.rootObservationId ?? record.id}` }) });
      const body: unknown = await response.json();
      if (!response.ok) { const problem = z.object({ error: z.object({ message: z.string() }) }).safeParse(body); throw new Error(problem.success ? problem.data.error.message : "复测任务保存未确认，请用同一按钮重新确认。"); }
      setReceipt(receiptSchema.parse(body));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "复测保存未确认"); }
    finally { setPending(false); }
  }
  return <div className="space-y-2 border-t border-zinc-200 pt-3">
    {receipt ? <div role="status" className="space-y-2"><p className="text-sm leading-7">延迟复测已存入今日任务，最早 {new Date(receipt.notBeforeAt).toLocaleString("zh-CN")} 开始。提前打开不会发放新题，提前提交会被服务器拒绝。</p><Link className={ui.secondary} href={receipt.href}>打开这项延迟复测</Link><Link className={ui.quiet} href="/opening/today">查看正式任务</Link></div> : <><button type="button" className={ui.secondary} disabled={pending || record.serverEvaluation?.decision === "abstain"} onClick={() => void schedule()}>{pending ? "正在保存复测任务…" : "安排 3 天后的正式延迟复测"}</button><p className="text-xs leading-6 text-zinc-500">使用既有复测任务与时间门槛，3 天是可解释的初始排程规则。期间的材料、提示或解析交付继续影响证据资格；不会提前宣称保持。</p></>}
    {error ? <p role="alert" className="text-xs leading-6 text-red-700">{error}</p> : null}
  </div>;
}
