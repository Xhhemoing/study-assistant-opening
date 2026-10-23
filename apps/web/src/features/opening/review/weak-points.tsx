"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useState } from "react";
import { EmptyState, LoadError, LoadingRows, ui } from "../design/ui";
import { errorCauses, practiceHref, retestQueueHref, readCauses, writeCauses, weakPointStateLabels, type ErrorCause, type WeakPoint } from "./weak-points-model";
import { readWeakPoints } from "./weak-points-client";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; points: WeakPoint[]; incomplete: boolean };

const storage = () => (typeof window === "undefined" ? null : window.localStorage);

/** Current review priorities and past struggles; student-selected causes stay local. */
export function WeakPoints() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const [causes, setCauses] = useState<Record<string, ErrorCause>>({});
  useEffect(() => { setCauses(readCauses(storage())); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void readWeakPoints(controller.signal).then(result => { if (!controller.signal.aborted) setState({ kind: "ready", ...result }); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setState({ kind: "error", message: reason instanceof Error ? reason.message : "易错点暂时无法读取" }); });
    return () => controller.abort();
  }, [revision]);

  const choose = (key: string, cause: ErrorCause | null) => setCauses(current => {
    const next = { ...current };
    if (cause && current[key] !== cause) next[key] = cause; else delete next[key];
    writeCauses(storage(), next);
    return next;
  });

  if (state.kind === "loading") return <LoadingRows label="正在整理易错点…" />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={() => setRevision(value => value + 1)} />;
  return <section aria-labelledby="weak-points-heading" className="space-y-3">
    <h2 id="weak-points-heading" className="font-semibold">易错点 · {state.points.length}</h2>
    {state.incomplete ? <p role="status" className="text-meta text-warn">学习记录尚未完整读取，列表可能不完整。请重新读取后再安排复习。<button type="button" className={ui.quiet} onClick={() => setRevision(value => value + 1)}>重新读取</button></p> : null}
    {!state.points.length ? <EmptyState title="还没有易错点" description="答错、非独立完成或需要核对的记录会整理到这里。" /> : null}
    <ul className="stagger divide-y divide-line rounded-xl border border-line">
      {state.points.map(point => <li key={point.key} className="space-y-2 p-4" data-weak-point="true">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-ui-lg font-medium">{point.skillLabel}</h3>
            <p className="text-meta font-medium">{weakPointStateLabels[point.state]}</p>
            <p className="text-meta text-text-2">{point.courseTitle} · 历史答错 {point.incorrect} 次{point.assisted ? ` · 非独立完成 ${point.assisted} 次` : ""}{point.independentCorrect ? ` · 独立做对 ${point.independentCorrect} 次` : ""}</p>
            {!point.identityKnown ? <p className="text-meta text-text-2">学习关联待确认，这条记录单独保留。</p> : null}
            {point.state === "recent_independent" ? <p className="text-meta text-text-2">最近已独立做对，之后再检查能否记住和迁移。</p> : null}
            {point.state === "delayed_checked" ? <p className="text-meta text-text-2">延迟后的独立作答通过，后续仍按计划复习。</p> : null}
          </div>
          {point.state === "due_retest"
            ? <a className={ui.secondary} href={retestQueueHref(point)}>查看到期复测</a>
            : <Link className={ui.secondary} href={practiceHref(point)}>围绕此技能练习</Link>}
        </div>
        <div role="group" aria-label={`${point.skillLabel} 的错因`} className="flex flex-wrap gap-1.5">
          {errorCauses.map(cause => <button key={cause.id} type="button" aria-pressed={causes[point.key] === cause.id} onClick={() => choose(point.key, cause.id)}
            className={`min-h-8 rounded-pill border px-2.5 text-meta transition-colors ${causes[point.key] === cause.id ? "border-ink bg-ink text-on-ink" : "border-line text-text-2 hover:bg-surface-2"}`}>{cause.label}</button>)}
        </div>
      </li>)}
    </ul>
    {state.points.length ? <p className="text-meta text-text-2">错因由你自己选择，仅保存在本机，不作为系统批改或掌握度依据。</p> : null}
  </section>;
}
