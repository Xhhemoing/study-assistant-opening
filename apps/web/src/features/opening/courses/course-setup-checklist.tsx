"use client";

import type { CourseKnowledgeSync, CourseRouteSnapshot } from "@aistudy/contracts";
import { CircleCheck, CircleDashed } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { tone, ui } from "../design/ui";
import { conversationObjectHref, validConversationId } from "../assistant/conversation-links";
import { KnowledgeRebuildControl, type KnowledgeRebuildTerminalOutcome } from "../knowledge/knowledge-rebuild-control";
import { createKnowledgeRebuildClient, type CourseKnowledgeRecord, type KnowledgeRebuildClient } from "../knowledge/knowledge-rebuild-client";

type KnowledgeStatus =
  | { status: "loading" }
  | { status: "unavailable" }
  | {
      status: "ready";
      nodeCount: number;
      sync?: CourseKnowledgeSync;
      lastAttemptOutcome?: KnowledgeRebuildTerminalOutcome | null;
    };

function isKnowledgeSyncComplete(
  nodeCount: number,
  sync?: CourseKnowledgeSync,
  lastAttemptOutcome?: KnowledgeRebuildTerminalOutcome | null,
): boolean {
  if (nodeCount <= 0) return false;
  if (lastAttemptOutcome === "cancelled" || lastAttemptOutcome === "outcome_unknown") {
    return false;
  }
  if (!sync) return true;
  if (sync.requestedJob?.state === "cancelled" || sync.requestedJob?.state === "outcome_unknown") {
    return false;
  }
  return (
    sync.status === "up_to_date"
    && sync.parsingSourceCount === 0
    && (sync.unreadableSourceCount ?? 0) === 0
    && sync.rebuildBlockedByMaterials !== true
    && !sync.lastFailedJob
  );
}

function describeKnowledgeDetail(knowledge: Extract<KnowledgeStatus, { status: "ready" }>): string {
  const { nodeCount, sync, lastAttemptOutcome } = knowledge;
  const parsingCount = sync?.parsingSourceCount ?? 0;
  const unreadableCount = sync?.unreadableSourceCount ?? 0;
  const attemptOutcome = lastAttemptOutcome
    ?? (sync?.requestedJob
      && (sync.requestedJob.state === "cancelled" || sync.requestedJob.state === "outcome_unknown" || sync.requestedJob.state === "failed")
      ? sync.requestedJob.state
      : null);

  if (sync?.rebuildBlockedByMaterials === true) {
    return `旧知识点已保留（共 ${nodeCount} 个），请先在资料页处理未就绪或无法读取的资料后再重新整理。`;
  }
  if (sync?.status === "pending") {
    const parts: string[] = [];
    if (parsingCount > 0) parts.push(`另有 ${parsingCount} 份资料仍在解析中`);
    if (unreadableCount > 0) parts.push(`另有 ${unreadableCount} 份资料无法读取文字`);
    const extra = parts.length ? `，${parts.join("，")}` : "";
    return `正在后台整理知识点${nodeCount ? `（当前保留 ${nodeCount} 个知识点）` : ""}${extra}。`;
  }
  if (sync?.lastFailedJob) {
    const lead = sync.lastFailedJob.state === "outcome_unknown" ? "上次整理结果暂未确认" : "上次整理未能完成";
    return `${lead}${nodeCount ? `（当前有 ${nodeCount} 个已有知识点）` : ""}，请检查资料或稍后重试。`;
  }
  if (attemptOutcome === "cancelled") {
    return `本次整理已取消${nodeCount ? `（当前保留 ${nodeCount} 个已有知识点）` : ""}，如需更新请重新整理知识点。`;
  }
  if (attemptOutcome === "outcome_unknown") {
    return `本次整理结果暂未确认${nodeCount ? `（当前有 ${nodeCount} 个已有知识点）` : ""}，请稍后刷新确认。`;
  }
  if (sync?.status === "needs_rebuild") {
    const extra = unreadableCount > 0 ? `（另有 ${unreadableCount} 份资料无法读取文字）` : "";
    return `课程材料已更新，当前知识点尚未同步最新材料${extra}，请重新整理知识点。`;
  }
  if (unreadableCount > 0 || parsingCount > 0) {
    const issues: string[] = [];
    if (unreadableCount > 0) issues.push(`有 ${unreadableCount} 份资料无法读取文字`);
    if (parsingCount > 0) issues.push(`有 ${parsingCount} 份资料仍在解析中`);
    const prefix = nodeCount ? `已整理出 ${nodeCount} 个知识点，但` : "尚未完成全部整理，";
    return `${prefix}${issues.join("，")}，请前往资料页查看处理后再整理。`;
  }
  if (nodeCount === 0 && sync?.status === "up_to_date" && Object.keys(sync.eligibleSourceVersions).length > 0) {
    return "已检查可读资料，暂未提取到知识点。可以补充资料后再点“整理知识点”。";
  }
  if (attemptOutcome === "failed" && nodeCount > 0) {
    return `全课当前已有 ${nodeCount} 个最新知识点（由后续整理同步），但刚才发起的那次整理未能完成。`;
  }
  return nodeCount ? `已整理出 ${nodeCount} 个知识点。` : "还没有整理出知识点。资料解析完成后，点“整理知识点”。";
}

function courseChecklistHref(courseId: string, href: string, originalConversationId?: string | null): string {
  if (!originalConversationId || !validConversationId(originalConversationId)) return href;
  if (href.startsWith("?") || href.startsWith("#")) {
    return conversationObjectHref(`/opening/courses/${encodeURIComponent(courseId)}${href}`, originalConversationId);
  }
  return conversationObjectHref(href, originalConversationId);
}

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

export function CourseSetupChecklist({ courseId, snapshot, goals, goalId, goalsUnavailable, goalsHref, archived = false, scopeActionDisabled = false, reloadToken = 0, originalConversationId, knowledgeClient, onReviewScope, onKnowledgeRebuilt }: {
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
  originalConversationId?: string | null;
  knowledgeClient?: KnowledgeRebuildClient;
  onReviewScope: () => void;
  onKnowledgeRebuilt: () => void;
}) {
  const client = useMemo(() => knowledgeClient ?? createKnowledgeRebuildClient(), [knowledgeClient]);
  const [knowledge, setKnowledge] = useState<KnowledgeStatus>({ status: "loading" });
  const requestSeq = useRef(0);
  useEffect(() => {
    if (archived) {
      requestSeq.current += 1;
      return;
    }
    const seq = ++requestSeq.current;
    void client.read(courseId)
      .then(record => {
        if (requestSeq.current === seq) {
          setKnowledge({
            status: "ready",
            nodeCount: record.snapshot.nodes.length,
            sync: record.sync,
            lastAttemptOutcome: null,
          });
        }
      })
      .catch(() => {
        if (requestSeq.current === seq) {
          setKnowledge({ status: "unavailable" });
        }
      });
    return () => { requestSeq.current += 1; };
  }, [archived, client, courseId, reloadToken]);
  function rebuilt(record: CourseKnowledgeRecord) {
    requestSeq.current += 1;
    setKnowledge({
      status: "ready",
      nodeCount: record.snapshot.nodes.length,
      sync: record.sync,
      lastAttemptOutcome: null,
    });
    onKnowledgeRebuilt();
  }
  function syncUpdated(record: CourseKnowledgeRecord, outcome: KnowledgeRebuildTerminalOutcome) {
    requestSeq.current += 1;
    setKnowledge({
      status: "ready",
      nodeCount: record.snapshot.nodes.length,
      sync: record.sync,
      lastAttemptOutcome: outcome,
    });
  }

  const total = snapshot.materials.length, available = snapshot.materials.filter(material => material.available).length;
  const materialsDone = total > 0 && available === total;
  const materialsDetail = !total ? "还没有课程资料，先上传讲义或教材。" : materialsDone ? `${total} 份资料都已解析可用。` : `${available}/${total} 份资料已解析可用，其余仍在解析或暂不可用。`;
  const hasNodes = knowledge.status === "ready" && knowledge.nodeCount > 0;
  const knowledgeDone = knowledge.status === "ready"
    && isKnowledgeSyncComplete(knowledge.nodeCount, knowledge.sync, knowledge.lastAttemptOutcome);
  const knowledgeDetail = archived ? "课程已归档，恢复课程后可整理知识点。"
    : knowledge.status === "loading" ? "正在读取整理结果…"
    : knowledge.status === "unavailable" ? "整理结果暂不可读取，可以重新读取课程路线后再看。"
    : describeKnowledgeDetail(knowledge);
  const goal = goals?.find(item => item.id === goalId) ?? null;
  const goalDetail = goalsUnavailable ? "目标暂不可读取，请重新读取课程路线。"
    : !goals ? "正在读取课程目标…"
    : goal ? `本次路线目标：${goal.title}`
    : goals.length ? "在下方“本次路线目标”中选择一个目标。" : "还没有关联本课程的目标，先去创建一个。";
  const scopeDone = snapshot.scopeState === "confirmed";
  const scopeDetail = scopeDone ? `已确认 ${snapshot.summary.total} 项课程要求。`
    : snapshot.scopeState === "unconfirmed" ? "有课程要求尚未确认，请对照大纲核对后确认。"
    : snapshot.suggestions.length ? `已整理出 ${snapshot.suggestions.length} 项要求建议，核对后确认全课范围。` : "还没有课程要求；可以先整理知识点获得建议，也可以手动添加。";

  const materialsHref = courseChecklistHref(courseId, "?tab=materials#course-assets", originalConversationId);
  const resolvedGoalsHref = courseChecklistHref(courseId, goalsHref, originalConversationId);

  return <section aria-labelledby="course-setup-heading" className="space-y-1">
    <h3 id="course-setup-heading" className="text-sm font-semibold">建课清单</h3>
    <ol className="divide-y divide-line border-y border-line">
      <SetupItem done={materialsDone} title="资料已解析" detail={materialsDetail}>{materialsDone ? null : <a className={ui.quiet} href={materialsHref}>去资料页</a>}</SetupItem>
      <SetupItem done={knowledgeDone} title="知识已整理" detail={knowledgeDetail}>{archived ? null : <KnowledgeRebuildControl courseId={courseId} client={client} organized={hasNodes} onRebuilt={rebuilt} onSyncUpdated={syncUpdated} />}</SetupItem>
      <SetupItem done={Boolean(goal)} title="已选目标" detail={goalDetail}>{goal ? null : <a className={ui.quiet} href={resolvedGoalsHref}>去目标与成功标准</a>}</SetupItem>
      <SetupItem done={scopeDone} title="范围已确认" detail={scopeDetail}>{scopeDone || archived ? null : <button type="button" className={ui.quiet} disabled={scopeActionDisabled} onClick={onReviewScope}>去确认全课范围</button>}</SetupItem>
    </ol>
  </section>;
}
