"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Crosshair,
  RefreshCw,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CourseRequirementProgress,
  CourseRouteSnapshot,
  CourseRouteTaskContext,
} from "@aistudy/contracts";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { subscribeOpeningPrivacyChange } from "../client/privacy-change";
import type { CourseRouteClient } from "../courses/course-route-client";
import { tone, ui } from "../design/ui";
import {
  usePaperReviewSession,
  type PaperReviewRequirementRef,
} from "../shared/paper-review-session";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { requirementStatusBadgeTone } from "./asset-graph-canvas";
import {
  EXAM_PICKER_BUCKET_LABELS,
  EXAM_PICKER_PRACTICE_MINUTES,
  buildCourseExamPickerPlan,
  resolveRetestTaskBinding,
  type ExamPickerBucket,
  type ExamPickerItem,
} from "./asset-graph-exam-picker";
import { REQUIREMENT_STATUS_LABELS } from "./asset-graph-model";

const DEFAULT_VISIBLE_RECOMMENDATIONS = 6;

function bucketBadgeTone(bucket: ExamPickerBucket): string {
  switch (bucket) {
    case "needs_correction":
      return tone.danger;
    case "due_retest":
      return tone.warning;
    case "pending_verification":
      return tone.neutral;
    case "unobserved":
      return tone.neutral;
  }
}

export type AssetGraphExamPanelProps = {
  courseId: string;
  courseTitle?: string | null;
  asOf?: string | null;
  routeClient: Partial<Pick<CourseRouteClient, "read" | "task">>;
  busy?: boolean;
  startingRequirementId?: string | null;
  onLocateRequirement: (requirementId: string) => void;
  onStartOrdinaryPractice: (
    courseId: string,
    progress: CourseRequirementProgress,
    minutes: number,
  ) => void;
  onStartBoundRetest: (
    courseId: string,
    taskContext: Extract<CourseRouteTaskContext, { managed: true }>,
  ) => void;
};

export function AssetGraphExamPanel({
  courseId,
  courseTitle = null,
  asOf = null,
  routeClient,
  busy = false,
  startingRequirementId = null,
  onLocateRequirement,
  onStartOrdinaryPractice,
  onStartBoundRetest,
}: AssetGraphExamPanelProps) {
  const [snapshot, setSnapshot] = useState<CourseRouteSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [showAllItems, setShowAllItems] = useState(false);
  const [showBlockedList, setShowBlockedList] = useState(false);
  const [taskContexts, setTaskContexts] = useState<Record<string, CourseRouteTaskContext | null>>(
    {},
  );
  const [loadingTaskIds, setLoadingTaskIds] = useState<ReadonlySet<string>>(() => new Set());

  const readGenerationRef = useRef(0);
  const taskGenerationRef = useRef(0);

  const canReadRoute = typeof routeClient.read === "function";

  const triggerReload = useCallback(() => {
    setReloadTick(prev => prev + 1);
  }, []);

  useEffect(() => {
    return subscribeOpeningPrivacyChange(() => {
      setSnapshot(null);
      setTaskContexts({});
      setLoadingTaskIds(new Set());
      setError("");
      setReloadTick(prev => prev + 1);
    });
  }, []);

  useEffect(() => {
    if (!canReadRoute || !routeClient.read) return;
    const generation = ++readGenerationRef.current;
    let active = true;
    setLoading(true);
    setError("");
    setTaskContexts({});
    setLoadingTaskIds(new Set());

    void routeClient
      .read(courseId)
      .then(result => {
        if (!active || readGenerationRef.current !== generation) return;
        setSnapshot(result);
      })
      .catch(reason => {
        if (!active || readGenerationRef.current !== generation) return;
        setSnapshot(null);
        setError(userFacingMessage(reason, "当前未能读取本课学习要求，请稍后重试。"));
      })
      .finally(() => {
        if (!active || readGenerationRef.current !== generation) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [canReadRoute, courseId, routeClient, reloadTick]);

  const requirementRefs = useMemo<readonly PaperReviewRequirementRef[] | undefined>(() => {
    if (!snapshot) return undefined;
    return snapshot.requirements.map(item => ({
      id: item.requirement.id,
      revision: item.requirement.revision,
    }));
  }, [snapshot]);

  const paperScope = useMemo(() => ({ kind: "course" as const, id: courseId }), [courseId]);
  const paper = usePaperReviewSession(paperScope, requirementRefs);

  const plan = useMemo(() => {
    if (!snapshot) return null;
    return buildCourseExamPickerPlan(snapshot, {
      asOf,
      isPaperMarked: (reqId, revision) => paper.isMarked(reqId, revision),
    });
  }, [snapshot, asOf, paper]);

  const dueRetestTaskIdsKey = plan ? plan.dueRetestTaskIds.join(",") : "";

  useEffect(() => {
    const taskIds = dueRetestTaskIdsKey ? dueRetestTaskIdsKey.split(",") : [];
    if (taskIds.length === 0 || !routeClient.task) {
      setLoadingTaskIds(new Set());
      return;
    }

    const generation = ++taskGenerationRef.current;
    let active = true;
    setLoadingTaskIds(new Set(taskIds));

    void Promise.all(
      taskIds.map(async taskId => {
        try {
          const context = await routeClient.task!(courseId, taskId);
          return [taskId, context] as const;
        } catch {
          return [taskId, null] as const;
        }
      }),
    ).then(entries => {
      if (!active || taskGenerationRef.current !== generation) return;
      const nextMap: Record<string, CourseRouteTaskContext | null> = {};
      for (const [taskId, context] of entries) {
        nextMap[taskId] = context;
      }
      setTaskContexts(nextMap);
      setLoadingTaskIds(new Set());
    });

    return () => {
      active = false;
    };
  }, [courseId, dueRetestTaskIdsKey, routeClient]);

  if (!canReadRoute) return null;

  const confirmScopeHref = `/opening/courses/${encodeURIComponent(courseId)}#course-learning-route`;
  const courseMaterialsHref = `/opening/courses/${encodeURIComponent(courseId)}`;

  const visibleItems: readonly ExamPickerItem[] =
    plan && !showAllItems ? plan.items.slice(0, DEFAULT_VISIBLE_RECOMMENDATIONS) : (plan?.items ?? []);

  return (
    <section
      aria-label="全课考前挑题与纸上复习核对"
      data-exam-picker-panel
      className="space-y-3 rounded-tile border border-line bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardCheck size={16} aria-hidden="true" className="text-accent" />
            <h2 className="text-sm font-semibold text-text">
              全课考前挑题{courseTitle ? ` · ${courseTitle}` : ""}
            </h2>
            {plan && plan.scopeState === "confirmed" ? (
              <span className={`${ui.badge} ${tone.neutral}`} data-exam-denominator>
                全课共 {plan.totalCount} 项要求，已验证 {plan.verifiedCount} 项
              </span>
            ) : null}
          </div>
          <p className="text-meta text-text-3">
            基于本课已确认的完整要求清单排序，并结合本轮纸上复习进度协助挑题。
          </p>
        </div>

        <button
          type="button"
          className={ui.quiet}
          disabled={loading}
          onClick={triggerReload}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {loading ? "读取中…" : "刷新清单"}
        </button>
      </div>

      {loading && !snapshot ? (
        <p role="status" className="text-sm text-text-2">
          正在读取本课完整学习要求…
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-ctl border border-danger/40 bg-surface-2/60 px-3 py-2 text-xs text-danger"
        >
          <span>{error}</span>
          <button type="button" className={ui.secondary} onClick={triggerReload}>
            重试读取
          </button>
        </div>
      ) : null}

      {snapshot && plan && plan.scopeState !== "confirmed" ? (
        <div
          role="status"
          data-scope-unconfirmed-banner
          className="flex flex-wrap items-center justify-between gap-3 rounded-ctl border border-warn bg-warn-soft px-3.5 py-3 text-sm text-warn"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p>当前课程尚有待确认的学习要求范围，请先确认范围后再按全课优先级挑题</p>
          </div>
          <Link href={confirmScopeHref} className={ui.secondary}>
            前往确认学习要求范围
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      {snapshot && plan && plan.scopeState === "confirmed" ? (
        <div className="space-y-3">
          <div
            data-paper-review-bar
            className="flex flex-wrap items-center justify-between gap-2 rounded-ctl border border-line bg-surface-2/50 px-3 py-2 text-xs"
          >
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2 font-medium text-text">
                <span>第 {paper.roundNumber} 轮纸上复习</span>
                <span className="text-text-2">
                  本轮纸上已复习 {paper.markedCount} / {plan.totalCount} 项
                </span>
              </div>
              <p className="text-micro text-text-3">
                纸上勾选仅保留在当前浏览器会话内，不替代真实练习记录，也不会改写课程达成判断。
              </p>
              {!paper.storageAvailable ? (
                <p className="text-micro text-warn">
                  当前浏览器会话暂未启用跨页缓存，勾选状态仅在本页保留。
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {paper.canUndo ? (
                <button type="button" className={ui.quiet} onClick={() => paper.undo()}>
                  <Undo2 size={13} aria-hidden="true" />
                  撤销上一步
                </button>
              ) : null}
              <button
                type="button"
                className={ui.secondary}
                disabled={paper.markedCount === 0}
                onClick={() => paper.startNextRound()}
              >
                <RotateCcw size={13} aria-hidden="true" />
                开启新一轮纸上核对
              </button>
            </div>
          </div>

          {plan.blockedCount > 0 ? (
            <div
              data-blocked-requirements-banner
              className="space-y-2 rounded-ctl border border-warn/60 bg-warn-soft/60 px-3 py-2.5 text-xs text-text"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} aria-hidden="true" className="shrink-0 text-warn" />
                  <span>
                    另有 {plan.blockedCount} 项要求因材料待补齐暂不可直接开练，已单独列出而不混入下方推荐。
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={ui.quiet}
                    aria-expanded={showBlockedList}
                    onClick={() => setShowBlockedList(prev => !prev)}
                  >
                    {showBlockedList ? "收起待补齐项" : "查看待补齐项"}
                  </button>
                  <Link href={courseMaterialsHref} className="font-medium text-accent hover:underline">
                    前往补齐课程材料
                  </Link>
                </div>
              </div>
              {showBlockedList ? (
                <ul className="list-disc space-y-1 pl-5 text-text-2">
                  {plan.blockedItems.map(item => (
                    <li key={item.requirement.id}>{item.requirement.title}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {plan.items.length === 0 ? (
            <div className="flex items-center gap-2 rounded-ctl border border-line bg-surface-2/40 px-3.5 py-3 text-sm text-text-2">
              <CheckCircle2 size={16} aria-hidden="true" className="shrink-0 text-accent" />
              <span>
                {plan.blockedCount > 0
                  ? "除材料待补齐的要求外，其余已确认要求当前均已完成验证。"
                  : "全课已确认要求当前均已完成验证，可在下方地图自由复盘关联知识。"}
              </span>
            </div>
          ) : (
            <div className="space-y-2.5">
              <ul className="grid gap-2.5 md:grid-cols-2">
                {visibleItems.map(item => {
                  const req = item.progress.requirement;
                  const isStarting = busy && startingRequirementId === req.id;
                  const isLoadingTask = Boolean(
                    item.dueRetest && item.retestTaskId && loadingTaskIds.has(item.retestTaskId),
                  );
                  const retestBinding = item.dueRetest
                    ? resolveRetestTaskBinding(
                        item.retestTaskId ? taskContexts[item.retestTaskId] : null,
                        req.id,
                      )
                    : null;

                  return (
                    <li
                      key={req.id}
                      data-exam-picker-item={req.id}
                      data-exam-bucket={item.bucket}
                      className="flex flex-col justify-between gap-2.5 rounded-ctl border border-line bg-bg/50 p-3"
                    >
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`${ui.badge} ${bucketBadgeTone(item.bucket)}`}>
                            {EXAM_PICKER_BUCKET_LABELS[item.bucket]}
                          </span>
                          <span
                            className={`${ui.badge} ${requirementStatusBadgeTone(
                              item.progress.status,
                            )}`}
                          >
                            {REQUIREMENT_STATUS_LABELS[item.progress.status]}
                          </span>
                          {item.dueRetest && item.progress.status === "verified" ? (
                            <span className={`${ui.badge} ${tone.warning}`}>需到期独立复测</span>
                          ) : null}
                          {req.mandatory ? (
                            <span className={`${ui.badge} ${tone.neutral}`}>核心要求</span>
                          ) : null}
                        </div>

                        <p className="text-sm font-semibold text-text">{req.title}</p>

                        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-text-2">
                          <input
                            type="checkbox"
                            checked={item.paperMarked}
                            onChange={() => paper.toggle(req.id, req.revision)}
                            className="h-4 w-4 accent-accent"
                          />
                          <span>
                            {item.paperMarked ? "本轮纸上已复习（已勾选）" : "本轮纸上已复习"}
                          </span>
                        </label>
                      </div>

                      <div className="space-y-1.5 border-t border-line pt-2">
                        {item.dueRetest && retestBinding ? (
                          isLoadingTask ? (
                            <button type="button" className={`${ui.secondary} w-full`} disabled>
                              正在核对复测任务…
                            </button>
                          ) : retestBinding.kind === "bound_retest" ? (
                            <button
                              type="button"
                              className={`${ui.primary} w-full justify-between`}
                              disabled={busy}
                              onClick={() => onStartBoundRetest(courseId, retestBinding.taskContext)}
                            >
                              <span>{isStarting ? "正在开启复测…" : retestBinding.label}</span>
                              <ArrowRight size={14} aria-hidden="true" />
                            </button>
                          ) : (
                            <div className="space-y-1.5">
                              <p className="text-micro text-warn">{retestBinding.reason}</p>
                              <div className="flex flex-wrap gap-1.5">
                                <Link
                                  href={retestBinding.todayHref}
                                  className={`${ui.secondary} flex-1 justify-center`}
                                >
                                  前往今日任务继续复测
                                </Link>
                                <button
                                  type="button"
                                  className={`${ui.quiet} w-full`}
                                  disabled={busy}
                                  onClick={() =>
                                    onStartOrdinaryPractice(
                                      courseId,
                                      item.progress,
                                      EXAM_PICKER_PRACTICE_MINUTES,
                                    )
                                  }
                                >
                                  {isStarting ? "正在开启练习…" : retestBinding.ordinaryLabel}
                                </button>
                              </div>
                            </div>
                          )
                        ) : (
                          <button
                            type="button"
                            className={`${ui.primary} w-full justify-between`}
                            disabled={busy}
                            onClick={() =>
                              onStartOrdinaryPractice(
                                courseId,
                                item.progress,
                                EXAM_PICKER_PRACTICE_MINUTES,
                              )
                            }
                          >
                            <span>
                              {isStarting
                                ? "正在开启练习…"
                                : `开始 ${EXAM_PICKER_PRACTICE_MINUTES} 分钟练习`}
                            </span>
                            <ArrowRight size={14} aria-hidden="true" />
                          </button>
                        )}

                        <button
                          type="button"
                          className={`${ui.quiet} w-full`}
                          onClick={() => onLocateRequirement(req.id)}
                        >
                          <Crosshair size={13} aria-hidden="true" />
                          在图中定位这项要求
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {plan.items.length > DEFAULT_VISIBLE_RECOMMENDATIONS ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    className={ui.secondary}
                    aria-expanded={showAllItems}
                    onClick={() => setShowAllItems(prev => !prev)}
                  >
                    {showAllItems
                      ? "收起到前 6 项"
                      : `展开全部 ${plan.items.length} 项待推进要求`}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
