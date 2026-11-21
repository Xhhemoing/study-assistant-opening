"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { courseRouteNextSchema, courseRouteRetestScheduleSchema, type CourseRouteActionResult, type CourseRouteRetestReceipt, type CourseRouteSnapshot, type TeachingActivity, type TeachingActivitySummary } from "@aistudy/contracts";
import { createCourseRouteClient, CourseRouteRequestError, type CourseRouteClient } from "./course-route-client";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { CourseRouteVerificationControl } from "./course-route-verification-control";
import { conversationObjectHref } from "../assistant/conversation-links";
const commandSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("next"), input: courseRouteNextSchema }), z.object({ kind: z.literal("retest"), input: courseRouteRetestScheduleSchema })]);
type Command = z.infer<typeof commandSchema>;
function isNextPendingStale(command: Command, activityId: string, fresh: CourseRouteSnapshot): boolean {
  if (!fresh.currentRoute || fresh.currentActivity?.id !== activityId) return true;
  if (fresh.currentRoute.goalId !== command.input.goalId) return true;
  if (fresh.currentRoute.goalRevision !== command.input.expectedGoalRevision) return true;
  if (fresh.currentActivity.pathVersion !== command.input.expectedPathVersion) return true;
  if ((command.input.observationId ?? null) !== (fresh.observationId ?? null)) return true;
  return false;
}
function key(id: string) { return `aistudy:route-next:${id}`; }
function restore(activityId: string): Command | null { try { const raw = sessionStorage.getItem(key(activityId)); if (!raw) return null; const decoded: unknown = JSON.parse(raw), value = commandSchema.safeParse(decoded); if (value.success && value.data.input.activityId === activityId) return value.data; const legacy = courseRouteNextSchema.safeParse(decoded); return legacy.success && legacy.data.activityId === activityId ? { kind: "next", input: legacy.data } : null; } catch { return null; } }
type NextControlProps = {
  activity: TeachingActivity;
  originalConversationId?: string | null;
  client?: CourseRouteClient;
  onNavigate?: (href: string) => void;
  summaryStep?: TeachingActivitySummary["nextStep"] | null;
  onEvidenceChanged?: () => void;
};
export function CourseRouteNextControl(props: NextControlProps) {
  return props.activity.routeManaged && props.activity.courseId ? <NextControl key={props.activity.id} {...props} courseId={props.activity.courseId} /> : null;
}
function NextControl({ activity, courseId, originalConversationId, client: suppliedClient, summaryStep, onEvidenceChanged, onNavigate = href => window.location.assign(href) }: NextControlProps & { courseId: string }) {
  const client = useMemo(() => suppliedClient ?? createCourseRouteClient(), [suppliedClient]);
  const [pending, setPending] = useState<Command | null>(() => restore(activity.id));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [result, setResult] = useState<CourseRouteActionResult | null>(null), [retest, setRetest] = useState<CourseRouteRetestReceipt | null>(null), [storageWarning, setStorageWarning] = useState(false);
  const [requirementChanged, setRequirementChanged] = useState(false);
  const [evidenceChanged, setEvidenceChanged] = useState(false);
  const writing = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function execute(kind: Command["kind"]) {
    if (writing.current || requirementChanged || evidenceChanged || (pending && pending.kind !== kind)) return;
    const retryingUnknown = pending !== null; writing.current = true; setBusy(true); setError(""); setNotice("");
    try {
      let command = pending;
      if (!command) {
        const fresh = await client.read(courseId, activity.id);
        if (!active.current) return;
        if (!fresh.currentRoute || fresh.currentActivity?.id !== activity.id) throw new Error("当前活动的路线绑定暂不可读取，请返回课程核对。");
        if (summaryStep && fresh.observationId !== summaryStep.observationId) {
          setEvidenceChanged(true);
          setNotice("作答结果已更新，请重新读取小结。");
          return;
        }
        const input = { goalId: fresh.currentRoute.goalId, expectedGoalRevision: fresh.currentRoute.goalRevision, activityId: activity.id, expectedPathVersion: fresh.currentActivity.pathVersion, observationId: fresh.observationId, minutes: 20, clientKey: `route-${kind}:${crypto.randomUUID()}` };
        if (kind === "retest") {
          if (!fresh.observationId) throw new Error("当前活动还没有可用于复测安排的真实作答，请先提交并核对结果。");
          command = { kind, input: { ...input, observationId: fresh.observationId } };
        } else command = { kind, input };
        setPending(command); try { sessionStorage.setItem(key(activity.id), JSON.stringify(command)); } catch { setStorageWarning(true); }
      }
      if (command.kind === "next") { const value = await client.next(courseId, command.input); if (active.current) { setResult(value); if (value.kind === "ready") onNavigate(conversationObjectHref(value.href, originalConversationId)); } }
      else { const value = await client.scheduleRetest(courseId, command.input); if (active.current) setRetest(value); }
      setPending(null); try { sessionStorage.removeItem(key(activity.id)); } catch { /* Verified receipt resolves the command in memory. */ }
    } catch (reason) {
      const isClientRejection = reason instanceof CourseRouteRequestError && reason.status >= 400 && reason.status < 500 && reason.status !== 408;
      const isConflict = reason instanceof CourseRouteRequestError && reason.status === 409;
      if (isClientRejection && !retryingUnknown) { setPending(null); try { sessionStorage.removeItem(key(activity.id)); } catch { /* This first request was explicitly rejected. */ } }
      if (isConflict && retryingUnknown && pending) {
        try {
          const fresh = await client.read(courseId, activity.id);
          if (!active.current) return;
          if (isNextPendingStale(pending, activity.id, fresh)) {
            setPending(null);
            try { sessionStorage.removeItem(key(activity.id)); } catch { /* Cleared stale pending intent. */ }
            setNotice("课程路线或活动已更新，刚才的待确认安排已不能应用，请重新核对。");
            return;
          }
        } catch {
          if (!active.current) return;
        }
      }
      if (active.current) setError(userFacingMessage(reason, kind === "retest" ? "复测安排结果尚未确认，请保留本页并重新确认这次安排。" : "下一步安排结果尚未确认，请保留本页并重新确认这次安排。"));
    } finally { writing.current = false; if (active.current) setBusy(false); }
  }
  const retestCancelled = retest && (retest.taskStatus === "skipped" || ["cancelled", "declined", "invalidated", "superseded"].includes(retest.retestStatus));
  const retestDone = retest && (retest.taskStatus === "done" || retest.retestStatus === "completed");
  const summaryMode = summaryStep !== undefined;
  const summaryAction = pending?.kind ?? (summaryStep?.kind === "schedule_retest" ? "retest" : "next");
  const labels = {
    next: pending?.kind === "next" ? "重新确认这次下一步" : summaryStep?.kind === "assisted_check" ? "独立试做同类题" : "核对结果并安排下一步",
    retest: pending?.kind === "retest" ? "重新确认这次复测" : summaryMode ? "确认延迟复测安排" : "安排3天后复测",
  };
  const action = (kind: Command["kind"], buttonClass: string) => <button type="button" className={buttonClass}
    disabled={busy || requirementChanged || evidenceChanged || Boolean(pending && pending.kind !== kind)}
    onClick={() => void execute(kind)}>{busy && pending?.kind === kind ? "正在核对…" : labels[kind]}</button>;
  return <section className="space-y-2 border-t border-line pt-3" aria-label="课程路线下一步">
    {summaryMode ? <p className="text-xs leading-6 text-text-2">{pending ? "请先确认上次提交的结果。" : summaryStep?.kind === "assisted_check" ? "这次借助了帮助，先独立试一道同类题。" : summaryStep?.kind === "schedule_retest" ? "本次已独立答对，三天后可用一道新题复测。" : "按本次作答结果选择下一步。"}</p>
      : <p className="text-xs leading-6 text-text-3">根据本次结果安排下一步；普通学习的未校准判定不计入验证，可继续学习，前置练习完成后返回原要求。当前通过与延迟验证分开记录，不自动视作长期掌握。</p>}
    <div className="flex flex-wrap gap-2">{summaryMode ? (!retest && !result && !evidenceChanged ? action(summaryAction, ui.primary) : null) : <>{action("next", ui.secondary)}{action("retest", ui.quiet)}</>}</div>
    {pending ? <p role="status" className="text-xs text-warn">{pending.kind === "retest" ? "复测安排结果尚未确认" : "下一步结果尚未确认"}；原活动、版本和证据引用已保留。</p> : null}
    {storageWarning ? <p className="text-xs text-warn">恢复信息无法保存，请保留本页；刷新后可能无法恢复这次请求。</p> : null}
    {result?.kind === "choice" ? <div className="space-y-2"><p role="status" className="text-sm text-text-2">{result.message}</p><a className={ui.secondary} href={conversationObjectHref(result.href, originalConversationId)}>查看并处理下一步</a></div> : null}
    {retest ? <div role="status" className="space-y-2"><p className="text-sm text-text-2">{retestCancelled ? "复测已取消或失效，原任务与记录保留，不会重新安排。" : retestDone ? "已完成的复测记录保留，本次没有新建安排。" : `复测已安排，最早开始：${new Date(retest.notBeforeAt).toLocaleString("zh-CN")}`}</p>{!retestCancelled ? <a className={ui.secondary} href={conversationObjectHref(retest.href, originalConversationId)}>{retestDone ? "查看复测记录" : "打开复测任务（到时间后可开始）"}</a> : <a className={ui.quiet} href={conversationObjectHref(`/opening/courses/${courseId}?tab=progress#course-learning-records`, originalConversationId)}>查看学习记录</a>}</div> : null}
    {notice ? <p role="status" className="text-xs text-text-2">{notice}</p> : null}
    {evidenceChanged && onEvidenceChanged ? <button type="button" className={ui.quiet} onClick={() => { setEvidenceChanged(false); setNotice(""); onEvidenceChanged(); }}>重新读取小结</button> : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    {!summaryStep ? <CourseRouteVerificationControl courseId={courseId} activityId={activity.id} originalConversationId={originalConversationId} client={client} disabled={busy || Boolean(pending)} onConfirmed={() => { setRequirementChanged(true); setResult(null); }} /> : null}
    {requirementChanged ? <p role="status" className="text-xs text-text-2">要求版本已更新，请从课程路线明确开始新版本活动；本节答案和评价原样保留。</p> : null}
  </section>;
}
