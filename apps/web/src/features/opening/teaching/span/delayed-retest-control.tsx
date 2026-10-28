"use client";
import { TransitionLink as Link } from "../../v3/motion/view-transition";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { retestActivityStatusSchema, type LearningObservation } from "@aistudy/contracts";
import { createOpeningApi } from "../../client/api";
import { ui } from "../../design/ui";
import { userFacingMessage } from "../../../../lib/user-facing-error";
const receiptFields = z.object({ taskId: z.string().uuid(), activityId: z.string().uuid(), courseId: z.string().uuid(), notBeforeAt: z.string().datetime(), href: z.string() });
const receiptSchema = receiptFields.extend({ taskStatus: z.enum(["pending", "done", "skipped"]).optional(), activityStatus: retestActivityStatusSchema.optional() })
  .refine(value => value.href === `/opening/courses/${value.courseId}/study/span?retest=${value.activityId}`);
const automaticReceiptSchema = receiptFields.extend({ taskStatus: z.enum(["pending", "done", "skipped"]), activityStatus: retestActivityStatusSchema })
  .refine(value => value.href === `/opening/courses/${value.courseId}/study/span?retest=${value.activityId}`);
type Receipt = z.infer<typeof receiptFields> & { taskStatus?: "pending" | "done" | "skipped"; activityStatus?: z.infer<typeof retestActivityStatusSchema>; automatic: boolean };
/** 已核对的 span 结果仅在本课程已有明确授权时尝试自动安排。 */
export function shouldAutoScheduleRetest(record: Pick<LearningObservation, "serverEvaluation">): boolean {
  const decision = record.serverEvaluation?.decision;
  return record.serverEvaluation?.evaluatorVersion === "span-exact-v1" && Boolean(decision) && decision !== "abstain";
}

export function SpanDelayedRetestControl({ record }: { record: LearningObservation }) {
  const api = useMemo(() => createOpeningApi(), []);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [unknownMode, setUnknownMode] = useState<"automatic" | "manual" | null>(null);
  const busy = useRef(false), epoch = useRef(0);
  const autoGrantRevision = useRef<number | null>(null);
  async function schedule(automatic = false) {
    if (busy.current || automatic && autoGrantRevision.current === null) return;
    const current = epoch.current;
    busy.current = true; setPending(true); setError(""); setUnknownMode(null);
    let definitiveFailure = false;
    try {
      const response = await fetch(`/api/opening/teaching/span/delayed${automatic ? "/automatic" : ""}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ observationId: record.id, clientKey: `span-delayed:${record.rootObservationId ?? record.id}`, ...(automatic ? { expectedGrantRevision: autoGrantRevision.current } : {}) }) });
      definitiveFailure = !response.ok && response.status < 500;
      const body: unknown = await response.json();
      if (current !== epoch.current) return;
      if (!response.ok) { const problem = z.object({ error: z.object({ message: z.string() }) }).safeParse(body); throw new Error(problem.success ? problem.data.error.message : "复测任务保存未确认，请用同一按钮重新确认。"); }
      const saved = automatic ? automaticReceiptSchema.parse(body) : receiptSchema.parse(body);
      if (saved.courseId !== record.courseId) throw new Error("这条复测安排不属于当前课程。");
      setReceipt({ ...saved, automatic });
    } catch (reason) {
      if (current !== epoch.current) return;
      if (!definitiveFailure) setUnknownMode(automatic ? "automatic" : "manual");
      setError(`${definitiveFailure ? "" : "保存结果未确认。"}${userFacingMessage(reason, "请查看今日任务，或再次确认这次安排。")}`);
    } finally { if (current === epoch.current) { busy.current = false; setPending(false); } }
  }
  // 授权读取不能替代服务器对账号开关、课程、预算与取消历史的事务核对。
  useEffect(() => {
    const current = ++epoch.current;
    setReceipt(null); setUnknownMode(null); setError(""); autoGrantRevision.current = null;
    busy.current = false; setPending(false);
    if (!shouldAutoScheduleRetest(record)) return () => { epoch.current += 1; };
    busy.current = true; setPending(true);
    void api.getAdaptivePrefs().then(preferences => {
      if (current !== epoch.current) return;
      if (preferences.invalidStoredPrefs) throw new Error("导师授权暂时无法读取，请先核对授权；仍可手动安排复测。");
      const grant = preferences.prefs.spanTutorGrants?.[record.courseId];
      busy.current = false; setPending(false);
      if (grant?.enabled) { autoGrantRevision.current = grant.revision; void schedule(true); }
    }).catch(reason => {
      if (current === epoch.current) { busy.current = false; setPending(false); setError(userFacingMessage(reason, "自动复测授权暂时无法读取；仍可手动安排。")); }
    });
    return () => { epoch.current += 1; };
  }, [api, record.id]);
  const cancelled = receipt && (receipt.taskStatus === "skipped" || receipt.activityStatus && ["cancelled", "declined", "invalidated", "superseded"].includes(receipt.activityStatus));
  const completed = receipt && (receipt.taskStatus === "done" || receipt.activityStatus === "completed");
  return <div className="space-y-2 border-t border-line pt-3">
    {receipt ? <div role="status" className="space-y-2">
      {cancelled ? <p className="text-sm leading-7">这项复测已取消或失效，原记录保留，本次没有重新安排。</p>
        : completed ? <p className="text-sm leading-7">这项复测已完成，原记录保留，本次没有新增任务。</p>
          : <p className="text-sm leading-7">{receipt.automatic ? "已自动排进复习：" : "复习已加入今日任务："}{new Date(receipt.notBeforeAt).toLocaleString("zh-CN")} 之后再做一道新题。</p>}
      {!cancelled ? <Link className={ui.secondary} href={receipt.href}>{completed ? "回看这项复习" : "打开这项复习"}</Link> : null}
      <Link className={ui.quiet} href="/opening/today">查看今日任务</Link>
    </div> : <>
      <button type="button" className={ui.secondary} disabled={pending || record.serverEvaluation?.decision === "abstain"} onClick={() => void schedule(unknownMode === "automatic")}>
        {pending ? "正在核对复测安排…" : unknownMode === "automatic" ? "重新确认自动安排" : unknownMode === "manual" ? "重新确认复测安排" : "安排 3 天后再练习"}
      </button>
      <p className="text-xs leading-6 text-text-3">{unknownMode ? "先确认这次安排是否已保存，暂不更换安排方式。" : "隔 3 天再做一道新题，看看哪些内容还记得。"}</p>
    </>}
    {error ? <p role="alert" className="text-xs leading-6 text-danger">{error}</p> : null}
  </div>;
}
