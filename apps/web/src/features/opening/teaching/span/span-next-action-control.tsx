"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { LearningObservation } from "@aistudy/contracts";
import { TransitionLink as Link } from "../../v3/motion/view-transition";
import { ui } from "../../design/ui";
import { userFacingMessage } from "../../../../lib/user-facing-error";
type Session = { activityId: string; sessionId: string; courseId: string; revision: number };
const linkSchema = z.object({ label: z.string().min(1).max(200), href: z.string() });
const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), href: z.string(), activityId: z.string().uuid(), sessionId: z.string().uuid(), courseId: z.string().uuid(), label: z.string().min(1).max(200), resumed: z.boolean() }),
  z.object({ kind: z.literal("choice"), reason: z.enum(["unknown_evidence", "evidence_changed", "source_unavailable", "authorization_required", "cancelled", "expired", "unseen_unavailable"]), message: z.string().min(1).max(3000), primary: linkSchema, secondary: linkSchema.optional() }),
]);
type Result = z.infer<typeof resultSchema>;
type Request = { activityId: string; expectedRevision: number; observationId: string | null; clientKey: string };

/** A correction keeps its attempt time; an old row cannot lend the effective head's identity. */
export function currentSpanObservationId(observations: LearningObservation[], session: Pick<Session, "sessionId" | "courseId">): string | null {
  const records = [...new Map(observations.map(row => [row.id, row])).values()].filter(row => row.courseId === session.courseId && row.sessionId === session.sessionId);
  const superseded = new Set(records.flatMap(row => row.revisesObservationId ? [row.revisesObservationId] : []));
  return records.filter(row => !superseded.has(row.id) && row.revisionKind !== "retract" && (!row.effectiveHeadId || row.effectiveHeadId === row.id))
    .sort((a, b) => Date.parse(b.submittedAt ?? b.occurredAt) - Date.parse(a.submittedAt ?? a.occurredAt) || b.id.localeCompare(a.id))[0]?.id ?? null;
}
function localCourseHref(href: string, courseId: string): URL {
  const url = new URL(href, "https://opening.local");
  const base = `/opening/courses/${courseId}`;
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\") || /\s/.test(href) || url.origin !== "https://opening.local" || ![base, `${base}/study`, `${base}/study/span`].includes(url.pathname)) throw new Error("下一步入口与当前课程不一致。");
  return url;
}
function readResult(body: unknown, courseId: string): Result {
  const result = resultSchema.parse(body);
  if (result.kind === "ready") {
    const url = localCourseHref(result.href, courseId);
    if (result.courseId !== courseId || url.pathname !== `/opening/courses/${courseId}/study/span` || url.searchParams.get("lesson") !== result.activityId || url.hash
      || [...url.searchParams.keys()].some(key => key !== "lesson" && key !== "retest") || url.searchParams.getAll("lesson").length !== 1
      || url.searchParams.has("retest") && (!z.string().uuid().safeParse(url.searchParams.get("retest")).success || url.searchParams.getAll("retest").length !== 1)) throw new Error("服务器未返回本次活动的完整入口。");
  } else {
    for (const action of [result.primary, result.secondary].filter((value): value is z.infer<typeof linkSchema> => Boolean(value))) localCourseHref(action.href, courseId);
  }
  return result;
}
export function SpanNextActionControl({ session, observationId, onNavigate, onReload, disabled = false }: {
  session: Session; observationId: string | null; onNavigate?: (href: string) => void; onReload?: () => void; disabled?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "unknown" | "error" | "done">("idle");
  const [error, setError] = useState(""), [result, setResult] = useState<Result | null>(null);
  const attempt = useRef<Request | null>(null), busy = useRef(false), alive = useRef(true), origin = useRef(session.activityId);
  origin.current = session.activityId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const previous = attempt.current;
    if (result?.kind === "choice" && status === "done" && previous && (previous.activityId !== session.activityId || previous.expectedRevision !== session.revision || previous.observationId !== observationId)) {
      attempt.current = null; setResult(null); setStatus("idle"); setError("");
    }
  }, [result, status, session.activityId, session.revision, observationId]);
  async function advance(recheckAuthorization = false) {
    if (disabled || busy.current || status === "error" || status === "done" && !(recheckAuthorization && result?.kind === "choice" && result.reason === "authorization_required")) return;
    attempt.current ??= { activityId: session.activityId, expectedRevision: session.revision, observationId, clientKey: `span-next:${session.activityId}:${session.revision}:${observationId ?? "none"}` };
    const request = attempt.current, courseId = session.courseId;
    busy.current = true; setStatus("pending"); setError(""); setResult(null);
    let definitiveFailure = false;
    try {
      const response = await fetch("/api/opening/teaching/span/next", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      definitiveFailure = !response.ok && response.status < 500;
      const body: unknown = await response.json();
      if (!alive.current || origin.current !== request.activityId) return;
      if (!response.ok) { const problem = z.object({ error: z.object({ message: z.string() }) }).safeParse(body); throw new Error(problem.success ? problem.data.error.message : "学习位置已变化，请重新读取本节。"); }
      const next = readResult(body, courseId);
      setResult(next); setStatus("done");
      if (next.kind === "ready") { if (onNavigate) onNavigate(next.href); else window.location.assign(next.href); }
    } catch (reason) {
      if (alive.current && origin.current === request.activityId) { setStatus(definitiveFailure ? "error" : "unknown"); setError(`${definitiveFailure ? "" : "结果尚未确认。"}${userFacingMessage(reason, "原答案和学习位置保留，请确认这次安排。")}`); }
    } finally { busy.current = false; }
  }
  return <section className="space-y-2" aria-label="下一步学习安排">
    {result ? result.kind === "ready" ? <p role="status" className="text-sm text-text-2">下一步已准备好：<Link className={ui.primary} href={result.href}>{result.label}</Link></p>
      : <div className="space-y-2"><p role="status" className="text-sm leading-7 text-text-2">{result.message}</p><div className="flex flex-wrap gap-2"><Link className={ui.primary} href={result.primary.href}>{result.primary.label}</Link>{result.secondary ? <Link className={ui.quiet} href={result.secondary.href}>{result.secondary.label}</Link> : null}{result.reason === "authorization_required" ? <button type="button" className={ui.secondary} disabled={disabled} onClick={() => void advance(true)}>授权后重新核对下一步</button> : null}</div></div>
      : <button type="button" className={ui.primary} disabled={disabled || status === "pending" || status === "error"} onClick={() => void advance()}>{status === "pending" ? "正在核对下一步…" : status === "unknown" ? "重新确认这次安排" : "安排下一步学习"}</button>}
    {status === "unknown" ? <p className="text-xs leading-6 text-text-3">保留原活动版本和作答记录，继续确认同一次安排；不会自动换一项任务。</p> : null}
    {error ? <p role="alert" className="text-xs leading-6 text-danger">{error}</p> : null}
    {status === "error" && onReload ? <button type="button" className={ui.secondary} onClick={onReload}>重新读取本节</button> : null}
  </section>;
}
