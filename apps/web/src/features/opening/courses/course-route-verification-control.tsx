"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { courseRouteVerificationConfirmSchema, type CourseRouteSnapshot, type CourseRouteVerificationConfirm, type CourseRouteVerificationRead } from "@aistudy/contracts";
import { createCourseRouteClient, CourseRouteRequestError, type CourseRouteClient } from "./course-route-client";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
const key = (courseId: string, activityId: string) => `aistudy:route-verification:${courseId}:${activityId}`;
function restore(courseId: string, activityId: string): CourseRouteVerificationConfirm | null { try { const raw = sessionStorage.getItem(key(courseId, activityId)); const value = raw ? courseRouteVerificationConfirmSchema.safeParse(JSON.parse(raw)) : null; return value?.success && value.data.activityId === activityId ? value.data : null; } catch { return null; } }
export function CourseRouteVerificationControl(props: { courseId: string; activityId: string; client?: CourseRouteClient; disabled?: boolean; onConfirmed?: () => void }) { return <VerificationControl key={`${props.courseId}:${props.activityId}`} {...props} />; }
function VerificationControl({ courseId, activityId, client: suppliedClient, disabled = false, onConfirmed }: { courseId: string; activityId: string; client?: CourseRouteClient; disabled?: boolean; onConfirmed?: () => void }) {
  const client = useMemo(() => suppliedClient ?? createCourseRouteClient(), [suppliedClient]);
  const [review, setReview] = useState<CourseRouteVerificationRead | null>(null), [context, setContext] = useState<CourseRouteSnapshot["currentRoute"]>(null), [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<CourseRouteVerificationConfirm | null>(() => restore(courseId, activityId));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [storageWarning, setStorageWarning] = useState(false);
  const active = useRef(true), writing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  function remember(command: CourseRouteVerificationConfirm | null) { try { if (command) sessionStorage.setItem(key(courseId, activityId), JSON.stringify(command)); else sessionStorage.removeItem(key(courseId, activityId)); return true; } catch { return false; } }
  async function read() {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError("");
    try { const [value, route] = await Promise.all([client.verification(courseId, activityId), client.read(courseId, activityId)]);
      if (!active.current) return;
      if (!route.currentRoute || route.currentActivity?.id !== activityId) throw new Error("当前活动的课程要求不可读取，请回到课程核对。");
      setReview(value); setContext(route.currentRoute); setSelected([]);
      if (pending && value.requirementId === pending.requirementId && value.requirementRevision > pending.expectedRequirementRevision) { remember(null); setPending(null); setMessage("课程要求已更新，先前的确认不能直接应用。请核对当前题目与标准，原答案不会因此升级。"); }
    } catch (reason) { if (active.current) setError(userFacingMessage(reason, "已提交题目与标准暂不可读取，请稍后重试。")); }
    finally { writing.current = false; if (active.current) setBusy(false); }
  }
  async function confirm() {
    if (writing.current || disabled) return;
    if (!pending && (!review?.available || !context || !selected.length)) return;
    const command = pending ?? { goalId: context!.goalId, expectedGoalRevision: context!.goalRevision, activityId, expectedContentVersion: review!.contentVersion, requirementId: review!.requirementId, expectedRequirementRevision: review!.requirementRevision, itemVersionIds: [...selected].sort(), confirmed: true as const };
    const retryingUnknown = pending !== null;
    writing.current = true; setBusy(true); setError(""); setMessage(""); setPending(command); setStorageWarning(!remember(command));
    try { await client.confirmVerification(courseId, command); remember(null); if (active.current) { setPending(null); setReview(null); setSelected([]); setMessage("题目与评分标准已确认可用于后续验证。要求版本已更新；已有答案和评价没有升级。请返回课程路线，明确开始新版本的题目。"); onConfirmed?.(); } }
    catch (reason) { if (!retryingUnknown && reason instanceof CourseRouteRequestError && reason.status >= 400 && reason.status < 500) { remember(null); if (active.current) { setPending(null); setReview(null); } } if (active.current) setError(userFacingMessage(reason, "标准确认结果待核对，请保留本页并重新确认先前选择的题目。")); }
    finally { writing.current = false; if (active.current) setBusy(false); }
  }
  const locked = busy || disabled || Boolean(pending);
  return <details className="space-y-3 border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium text-text-2">题目与评分标准可用性</summary><div className="space-y-3 pt-2"><p className="text-xs leading-6 text-text-3">只核对这项活动已提交的真实题目和保存的评分标准。确认表示材料可用于后续验证，不表示已通过，也不会把受助或旧答案变成独立证据。</p><button className={ui.quiet} type="button" disabled={busy || disabled} onClick={() => void read()}>核对已提交题目与评分标准</button>
    {review ? <><div className="space-y-2"><h3 className="text-xs font-medium">当前课程要求的评分标准</h3><p className="whitespace-pre-wrap text-sm leading-6 text-text-2">{review.rubric ?? "尚未保存评分标准，请先到课程范围编辑。"}</p></div>{!review.available ? <p className="text-xs text-warn" role="status">{review.reason ?? "题目、标准或资料尚不可用。"}</p> : null}<fieldset disabled={locked || !review.available} className="space-y-3"><legend className={ui.label}>选择你已核对的题目</legend>{review.items.map(item => <label className="flex items-start gap-2 text-sm text-text-2" key={item.itemVersionId}><input className="mt-1" type="checkbox" checked={selected.includes(item.itemVersionId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.itemVersionId] : previous.filter(id => id !== item.itemVersionId))} /><span className="space-y-2"><span className="block whitespace-pre-wrap leading-7">{item.prompt}</span><span className="block text-xs font-medium">这道题保存的参考解答或评分标准</span><span className="block whitespace-pre-wrap text-sm leading-7">{item.referenceText ?? "原题实际参考暂不可读取，请重新核对后再确认。"}</span></span></label>)}</fieldset><button className={ui.secondary} type="button" disabled={locked || !review.available || !selected.length} onClick={() => void confirm()}>确认所选题目与标准可用于后续验证</button></> : null}
    {pending ? <div role="status" className="space-y-2"><p className="text-xs text-warn">标准确认结果待核对，先前选择的题目及其对应要求已保留。</p><button className={ui.secondary} type="button" disabled={busy || disabled} onClick={() => void confirm()}>重新确认这次标准核对</button></div> : null}
    {storageWarning ? <p className="text-xs text-warn">这次标准核对暂不能跨刷新恢复，请保留本页。</p> : null}{error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}{message ? <p className="text-xs text-text-2" role="status">{message}</p> : null}
    <a className={ui.quiet} href={`/opening/courses/${courseId}?tab=units#course-learning-route`}>返回课程路线核对并开始新题</a>
  </div></details>;
}
