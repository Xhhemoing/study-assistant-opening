"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LearningObservation } from "@aistudy/contracts";
import { createCourseHistoryClient } from "../client/history-client";
import { EmptyState, LoadError, LoadingRows, ui } from "../design/ui";
import { buildWeakPoints, errorCauses, practiceHref, readCauses, writeCauses, type ErrorCause, type WeakPoint } from "./weak-points-model";

type CourseRow = { id: string; title: string; archivedAt?: string | null };
type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; points: WeakPoint[]; partial: boolean };

const storage = () => (typeof window === "undefined" ? null : window.localStorage);

/** 我的易错点：按技能聚合答错与靠帮助完成的作答，可直接练同类题；错因由学生自己标。 */
export function WeakPoints() {
  const history = useMemo(() => createCourseHistoryClient(), []);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const [causes, setCauses] = useState<Record<string, ErrorCause>>({});
  useEffect(() => { setCauses(readCauses(storage())); }, []);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    (async () => {
      const response = await fetch("/api/courses", { method: "GET" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("课程暂时无法读取");
      const rows = body && typeof body === "object" && "courses" in body && Array.isArray(body.courses) ? body.courses as CourseRow[] : [];
      const courses = rows.filter(course => typeof course.id === "string" && !course.archivedAt);
      const results = await Promise.allSettled(courses.map(course => history.getHistory({ courseId: course.id, limit: 200 })));
      const observations: LearningObservation[] = [];
      let partial = false;
      results.forEach(result => { if (result.status === "fulfilled") observations.push(...result.value.observations); else partial = true; });
      return { points: buildWeakPoints(observations, new Map(courses.map(course => [course.id, course.title]))), partial };
    })().then(result => { if (active) setState({ kind: "ready", ...result }); })
      .catch((reason: unknown) => { if (active) setState({ kind: "error", message: reason instanceof Error ? reason.message : "易错点暂时无法读取" }); });
    return () => { active = false; };
  }, [history, revision]);

  const choose = (key: string, cause: ErrorCause | null) => setCauses(current => {
    const next = { ...current };
    if (cause && current[key] !== cause) next[key] = cause; else delete next[key];
    writeCauses(storage(), next);
    return next;
  });

  if (state.kind === "loading") return <LoadingRows label="正在整理易错点…" />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={() => setRevision(value => value + 1)} />;
  if (!state.points.length) return <EmptyState title="还没有易错点" description="答错或靠提示完成的题会按技能汇总到这里。" />;
  return <section aria-labelledby="weak-points-heading" className="space-y-3">
    <h2 id="weak-points-heading" className="font-semibold">易错点 · {state.points.length}</h2>
    {state.partial ? <p role="status" className="text-meta text-warn">部分课程暂时无法读取，列表可能不完整。</p> : null}
    <ul className="stagger divide-y divide-line rounded-xl border border-line">
      {state.points.map(point => <li key={point.key} className="space-y-2 p-4" data-weak-point="true">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-ui-lg font-medium">{point.skillLabel}</h3>
            <p className="text-meta text-text-2">{point.courseTitle} · 答错 {point.incorrect} 次{point.assisted ? ` · 靠帮助完成 ${point.assisted} 次` : ""}{point.independentCorrect ? ` · 独立做对 ${point.independentCorrect} 次` : ""}</p>
          </div>
          <Link className={ui.secondary} href={practiceHref(point)}>练一道同类题</Link>
        </div>
        <div role="group" aria-label={`${point.skillLabel} 的错因`} className="flex flex-wrap gap-1.5">
          {errorCauses.map(cause => <button key={cause.id} type="button" aria-pressed={causes[point.key] === cause.id} onClick={() => choose(point.key, cause.id)}
            className={`min-h-8 rounded-pill border px-2.5 text-meta transition-colors ${causes[point.key] === cause.id ? "border-ink bg-ink text-on-ink" : "border-line text-text-2 hover:bg-surface-2"}`}>{cause.label}</button>)}
        </div>
      </li>)}
    </ul>
  </section>;
}
