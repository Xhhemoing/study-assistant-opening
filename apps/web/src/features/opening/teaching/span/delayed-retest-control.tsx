"use client";
import { TransitionLink as Link } from "../../v3/motion/view-transition";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { LearningObservation } from "@aistudy/contracts";
import { ui } from "../../design/ui";
import { userFacingMessage } from "../../../../lib/user-facing-error";
const receiptSchema = z.object({ taskId: z.string().uuid(), notBeforeAt: z.string().datetime(), href: z.string().startsWith("/opening/courses/") });
/** 答错（需修正）的题自动排进 3 天后复测；答对或未定判分仍由学习者自己决定。 */
export function shouldAutoScheduleRetest(record: Pick<LearningObservation, "serverEvaluation">): boolean {
  const decision = record.serverEvaluation?.decision;
  return Boolean(decision) && decision !== "correct" && decision !== "abstain";
}

export function SpanDelayedRetestControl({ record }: { record: LearningObservation }) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<z.infer<typeof receiptSchema> | null>(null);
  const autoTried = useRef(false);
  async function schedule(auto = false) {
    if (pending) return;
    setPending(true); setError("");
    try {
      const response = await fetch("/api/opening/teaching/span/delayed", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ observationId: record.id, clientKey: `span-delayed:${record.rootObservationId ?? record.id}` }) });
      const body: unknown = await response.json();
      if (!response.ok) { const problem = z.object({ error: z.object({ message: z.string() }) }).safeParse(body); throw new Error(problem.success ? problem.data.error.message : "复测任务保存未确认，请用同一按钮重新确认。"); }
      setReceipt(receiptSchema.parse(body));
    } catch (reason) {
      // 自动安排失败（例如复测建议已关闭）时不打扰，保留手动按钮；手动点击才显示原因。
      if (!auto) setError(userFacingMessage(reason, "复测保存未确认"));
    }
    finally { setPending(false); }
  }
  // 同一份作答的提交标识固定，服务端按它去重：小结与反馈页同时出现、刷新重进都不会重复建任务。
  useEffect(() => {
    if (autoTried.current || !shouldAutoScheduleRetest(record)) return;
    autoTried.current = true;
    void schedule(true);
  }, [record.id]);
  return <div className="space-y-2 border-t border-line pt-3">
    {receipt ? <div role="status" className="space-y-2"><p className="text-sm leading-7">{shouldAutoScheduleRetest(record) ? "已自动排进复习：" : "复习已加入今日任务："}{new Date(receipt.notBeforeAt).toLocaleString("zh-CN")} 之后再做一道新题。</p><Link className={ui.secondary} href={receipt.href}>打开这项复习</Link><Link className={ui.quiet} href="/opening/today">查看今日任务</Link></div> : <><button type="button" className={ui.secondary} disabled={pending || record.serverEvaluation?.decision === "abstain"} onClick={() => void schedule(false)}>{pending ? "正在保存复测任务…" : "安排 3 天后再练习"}</button><p className="text-xs leading-6 text-text-3">隔 3 天再做一道新题，看看哪些内容还记得。</p></>}
    {error ? <p role="alert" className="text-xs leading-6 text-danger">{error}</p> : null}
  </div>;
}
