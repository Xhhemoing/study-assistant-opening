"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { LoadError, ui } from "../design/ui";
import { integrationSchema, overviewSchema } from "./client-schemas";

const courseExamSchema = z.object({ overview: overviewSchema, integration: integrationSchema }).nullable();
type CourseExam = z.infer<typeof courseExamSchema>;

export function CourseExamProgress({ courseId }: { courseId: string }) {
  const [data, setData] = useState<CourseExam>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetch(`/api/opening/courses/${encodeURIComponent(courseId)}/exam-sprint`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(`冲刺进度读取失败（${response.status}）。`); return courseExamSchema.parse(await response.json()); })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "冲刺进度读取失败。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [courseId, revision]);
  return <section className={`${ui.panel} space-y-3 p-4`} aria-labelledby="course-exam-progress-title"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="course-exam-progress-title" className="text-sm font-semibold">考前冲刺与学习证据</h2><Link className={ui.secondary} href={`/opening/sprint?courseId=${encodeURIComponent(courseId)}`}>{data ? "继续本课冲刺" : "关联考前冲刺"}</Link></div>{loading ? <p className="text-xs text-text-3" role="status">正在读取冲刺进度…</p> : error ? <LoadError message={error} onRetry={() => setRevision(value => value + 1)} /> : data ? <><div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><p>原题覆盖 <strong>{data.overview.summary.sourceCovered}/{data.overview.summary.sourceTotal}</strong></p><p>原题独立正确（自评） <strong>{data.overview.summary.sourceIndependent}</strong></p><p>在线新题族独立正确 <strong>{data.overview.summary.onlineIndependentCorrect}</strong></p><p>原题隔日通过（自评） <strong>{data.overview.summary.sourceDelayed}</strong></p></div><p className="text-xs leading-6 text-text-3">来源登记共 {data.overview.state.sourceRecords.length} 条；线上 {data.overview.skills.filter(skill => skill.status === "secure").length} 项客观题技能具有隔日稳固证据。覆盖、自评、在线作答分别显示，不汇总成掌握百分比。</p>{data.integration.courseGoal?.milestoneTitle ? <p className="text-xs text-text-2">关联阶段：{data.integration.courseGoal.milestoneTitle}</p> : null}</> : <p className="text-xs leading-6 text-text-3">将预置考点和串讲关联到本课后，在这里查看冲刺覆盖、独立作答与隔日复测。课程原有目标继续使用。</p>}</section>;
}
