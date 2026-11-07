"use client";

import type { CourseRouteSnapshot } from "@aistudy/contracts";
import { CircleCheck, CircleDashed } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { tone, ui } from "../design/ui";
import { KnowledgeRebuildControl } from "../knowledge/knowledge-rebuild-control";
import { createKnowledgeRebuildClient, type CourseKnowledgeRecord, type KnowledgeRebuildClient } from "../knowledge/knowledge-rebuild-client";

type KnowledgeStatus = { status: "loading" } | { status: "unavailable" } | { status: "ready"; nodeCount: number };

function SetupItem({ done, title, detail, children }: { done: boolean; title: string; detail: string; children?: ReactNode }) {
  const Icon = done ? CircleCheck : CircleDashed;
  return <li className="flex gap-3 py-3">
    <Icon aria-hidden="true" size={16} className={`mt-0.5 shrink-0 ${done ? "text-accent" : "text-text-3"}`} />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{title}<span className={`${ui.badge} ${done ? tone.success : tone.neutral}`}>{done ? "已完成" : "未完成"}</span></p>
      <p className="text-xs leading-5 text-text-3">{detail}</p>
      {children}
    </div>
  </li>;
}

export function CourseSetupChecklist({ courseId, snapshot, goals, goalId, goalsUnavailable, goalsHref, archived = false, scopeActionDisabled = false, reloadToken = 0, knowledgeClient, onReviewScope, onKnowledgeRebuilt }: {
  courseId: string;
  snapshot: Pick<CourseRouteSnapshot, "materials" | "scopeState" | "suggestions" | "summary">;
  /** Goals linked to this course; null until the goal list has been read. */
  goals: ReadonlyArray<{ id: string; title: string }> | null;
  goalId: string;
  goalsUnavailable: boolean;
  goalsHref: string;
  archived?: boolean;
  scopeActionDisabled?: boolean;
  reloadToken?: number;
  knowledgeClient?: KnowledgeRebuildClient;
  onReviewScope: () => void;
  onKnowledgeRebuilt: () => void;
}) {
  const client = useMemo(() => knowledgeClient ?? createKnowledgeRebuildClient(), [knowledgeClient]);
  const [knowledge, setKnowledge] = useState<KnowledgeStatus>({ status: "loading" });
  useEffect(() => {
    if (archived) return;
    let live = true;
    void client.read(courseId)
      .then(record => { if (live) setKnowledge({ status: "ready", nodeCount: record.snapshot.nodes.length }); })
      .catch(() => { if (live) setKnowledge({ status: "unavailable" }); });
    return () => { live = false; };
  }, [archived, client, courseId, reloadToken]);
  function rebuilt(record: CourseKnowledgeRecord) {
    setKnowledge({ status: "ready", nodeCount: record.snapshot.nodes.length });
    onKnowledgeRebuilt();
  }

  const total = snapshot.materials.length, available = snapshot.materials.filter(material => material.available).length;
  const materialsDone = total > 0 && available === total;
  const materialsDetail = !total ? "还没有课程资料，先上传讲义或教材。" : materialsDone ? `${total} 份资料都已解析可用。` : `${available}/${total} 份资料已解析可用，其余仍在解析或暂不可用。`;
  const knowledgeDone = knowledge.status === "ready" && knowledge.nodeCount > 0;
  const knowledgeDetail = archived ? "课程已归档，恢复课程后可整理知识点。"
    : knowledge.status === "loading" ? "正在读取整理结果…"
    : knowledge.status === "unavailable" ? "整理结果暂不可读取，可以重新读取课程路线后再看。"
    : knowledge.nodeCount ? `已整理出 ${knowledge.nodeCount} 个知识点。` : "还没有整理出知识点。资料解析完成后，点“整理知识点”。";
  const goal = goals?.find(item => item.id === goalId) ?? null;
  const goalDetail = goalsUnavailable ? "目标暂不可读取，请重新读取课程路线。"
    : !goals ? "正在读取课程目标…"
    : goal ? `本次路线目标：${goal.title}`
    : goals.length ? "在下方“本次路线目标”中选择一个目标。" : "还没有关联本课程的目标，先去创建一个。";
  const scopeDone = snapshot.scopeState === "confirmed";
  const scopeDetail = scopeDone ? `已确认 ${snapshot.summary.total} 项课程要求。`
    : snapshot.scopeState === "unconfirmed" ? "有课程要求尚未确认，请对照大纲核对后确认。"
    : snapshot.suggestions.length ? `已整理出 ${snapshot.suggestions.length} 项要求建议，核对后确认全课范围。` : "还没有课程要求；可以先整理知识点获得建议，也可以手动添加。";

  return <section aria-labelledby="course-setup-heading" className="space-y-1">
    <h3 id="course-setup-heading" className="text-sm font-semibold">建课清单</h3>
    <ol className="divide-y divide-line border-y border-line">
      <SetupItem done={materialsDone} title="资料已解析" detail={materialsDetail}>{materialsDone ? null : <a className={ui.quiet} href="?tab=materials#course-assets">去资料页</a>}</SetupItem>
      <SetupItem done={knowledgeDone} title="知识已整理" detail={knowledgeDetail}>{archived ? null : <KnowledgeRebuildControl courseId={courseId} client={client} organized={knowledgeDone} onRebuilt={rebuilt} />}</SetupItem>
      <SetupItem done={Boolean(goal)} title="已选目标" detail={goalDetail}>{goal ? null : <a className={ui.quiet} href={goalsHref}>去目标与成功标准</a>}</SetupItem>
      <SetupItem done={scopeDone} title="范围已确认" detail={scopeDetail}>{scopeDone || archived ? null : <button type="button" className={ui.quiet} disabled={scopeActionDisabled} onClick={onReviewScope}>去确认全课范围</button>}</SetupItem>
    </ol>
  </section>;
}
