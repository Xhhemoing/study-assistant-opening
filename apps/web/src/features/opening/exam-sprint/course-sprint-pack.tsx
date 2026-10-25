"use client";

import { useEffect, useState } from "react";
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
 * The built-in sample pack is shown only for a course already bound to it, or after the
 * learner explicitly opens the sample import entry. Unbound courses never load the pack.
 */
export function CourseSprintPack({ courseId, initialStatus = "loading" }: { courseId: string; initialStatus?: CoursePackStatus }) {
  const objectHref = useConversationObjectHref();
  const [status, setStatus] = useState<CoursePackStatus>(initialStatus);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [optedIn, setOptedIn] = useState(false);
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
  if (status === "loading") return <div className="mx-5 mb-6 sm:mx-7"><LoadingRows label="正在核对这门课的冲刺题包…" /></div>;
  if (status === "error") return <div className="mx-5 mb-6 sm:mx-7"><LoadError message={error} onRetry={() => setRetry(value => value + 1)} /></div>;
  if (status === "bound") return <details className="mx-5 mb-6 border-t border-line pt-3 sm:mx-7"><summary className="min-h-11 cursor-pointer py-2 text-sm text-text-2">题包训练与记录</summary><ExamSprintView courseId={courseId} embedded /></details>;
  const materialsHref = objectHref(`/opening/courses/${encodeURIComponent(courseId)}?tab=materials`);
  return <div className="mx-5 mb-6 space-y-3 border-t border-line pt-3 sm:mx-7">
    <EmptyState title="这门课还没有冲刺题包" description="冲刺会围绕这门课自己的资料安排练习。先在课程资料中上传讲义、往年题或习题，再回到这里规划冲刺。" action={<Link className={ui.primary} href={materialsHref}>查看课程资料</Link>} />
    <details className="rounded-lg border border-line p-3" onToggle={event => { if (event.currentTarget.open) setOptedIn(true); }}>
      <summary className="min-h-11 cursor-pointer py-2 text-sm text-text-2">导入示例题包</summary>
      <p className="my-2 text-xs leading-6 text-text-3">示例题包是一套预置的 Math I 练习，只有确认关联后才会进入这门课程。</p>
      {optedIn ? <ExamSprintView courseId={courseId} embedded /> : null}
    </details>
  </div>;
}
