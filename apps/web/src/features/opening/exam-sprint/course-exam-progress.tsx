"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useState } from "react";
import { courseExamOverviewSchema, type CourseExamOverview } from "@aistudy/contracts";
import { LoadError, ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

export function CourseExamProgress({ courseId }: { courseId: string }) {
  const [data, setData] = useState<CourseExamOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch(`/api/opening/courses/${encodeURIComponent(courseId)}/exam`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(`考前练习读取失败（${response.status}）。`); return courseExamOverviewSchema.parse(await response.json()); })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(userFacingMessage(reason, "冲刺进度读取失败。")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [courseId, revision]);
  const ready = data?.papers.filter(paper => paper.status === "ready" && paper.available) ?? [];
  return <section className={`${ui.panel} space-y-3 p-4`} aria-labelledby="course-exam-progress-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="course-exam-progress-title" className="text-sm font-semibold">考前练习</h2>
      <Link className={ui.secondary} href={`/opening/courses/${encodeURIComponent(courseId)}/exam`}>{ready.length ? "继续本课考前练习" : "上传真题并组卷"}</Link></div>
    {loading ? <p className="text-xs text-text-3" role="status">正在读取考前练习…</p>
      : error ? <LoadError message={error} onRetry={() => setRevision(value => value + 1)} />
      : ready.length ? <p className="text-sm text-text-2">已准备 {ready.length} 份模拟练习，共 {ready.reduce((sum, paper) => sum + paper.questionCount, 0)} 题。作答后的批改和错题会记录在这门课。</p>
      : <p className="text-sm text-text-2">用这门课的真题识别考点，再做一份新的变式练习。</p>}
  </section>;
}
