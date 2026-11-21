"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { EmptyState, LoadError, LoadingRows, ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { ExamSprintView } from "./sprint-view";

export type CoursePackStatus = "loading" | "bound" | "unbound" | "error";

/** The course-scoped sprint read returns null unless this exact course is bound to the pack. */
export function coursePackStatus(body: unknown): Exclude<CoursePackStatus, "loading" | "error"> {
  if (!body || typeof body !== "object") return "unbound";
  const integration = (body as { integration?: { binding?: unknown } }).integration;
  return integration && typeof integration === "object" && integration.binding ? "bound" : "unbound";
}

/**
 * An existing binding puts training before the plan. Unbound courses keep planning
 * first and load the sample pack only after the learner opens the import entry.
 */
export function CourseSprintPack({ workspaceId, courseId, initialStatus = "loading", children }: {
  workspaceId?: string;
  courseId: string;
  initialStatus?: CoursePackStatus;
  children?: ReactNode;
}) {
  const objectHref = useConversationObjectHref();
  const [status, setStatus] = useState<CoursePackStatus>(initialStatus);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [optedIn, setOptedIn] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const packId = useId();
  const packRef = useRef<HTMLElement>(null);
  const onCourseBound = useCallback(() => setStatus("bound"), []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading"); setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/opening/courses/${encodeURIComponent(courseId)}/exam-sprint`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? "登录状态已过期，请重新登录。" : "暂时无法读取冲刺题包，请重试。");
        const body: unknown = await response.json();
        if (!controller.signal.aborted) setStatus(coursePackStatus(body));
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(userFacingMessage(reason, "读取失败")); setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [courseId, retry]);

  const bound = status === "bound";
  useEffect(() => {
    if (bound && optedIn) packRef.current?.focus();
  }, [bound, optedIn]);

  const plan = <Fragment key="plan">{children}</Fragment>;
  if (status === "loading") return <>{plan}<div key="pack" className="mx-5 mb-6 sm:mx-7"><LoadingRows label="正在核对这门课的冲刺题包…" /></div></>;
  if (status === "error") return <>{plan}<div key="pack" className="mx-5 mb-6 sm:mx-7"><LoadError message={error} onRetry={() => setRetry(value => value + 1)} /></div></>;

  const materialsHref = objectHref(`/opening/courses/${encodeURIComponent(courseId)}?tab=materials`);
  const pack = <div key="pack" className="mx-5 mb-6 space-y-3 border-t border-line pt-3 sm:mx-7">
    {!bound ? <>
      <EmptyState title="这门课还没有冲刺题包" description="冲刺会围绕这门课自己的资料安排练习。先在课程资料中上传讲义、往年题或习题，再回到这里规划冲刺。" action={<Link className={ui.primary} href={materialsHref}>查看课程资料</Link>} />
      <button type="button" className={ui.quiet} aria-expanded={importOpen} aria-controls={packId} onClick={() => {
        setOptedIn(true);
        setImportOpen(open => !open);
      }}>导入示例题包</button>
    </> : null}
    <section id={packId} ref={packRef} tabIndex={-1} aria-label="题包训练" hidden={!bound && !importOpen}>
      {!bound ? <p className="my-2 text-xs leading-6 text-text-3">示例题包是一套预置的 Math I 练习，只有确认关联后才会进入这门课程。</p> : null}
      {bound || optedIn ? <ExamSprintView workspaceId={workspaceId} courseId={courseId} embedded onCourseBound={onCourseBound} /> : null}
    </section>
  </div>;

  return bound ? <>{pack}{plan}</> : <>{plan}{pack}</>;
}
