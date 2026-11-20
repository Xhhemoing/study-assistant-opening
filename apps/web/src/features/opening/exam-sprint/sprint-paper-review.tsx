"use client";

import type { CourseRouteSnapshot } from "@aistudy/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { subscribeOpeningPrivacyChange } from "../client/privacy-change";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { createCourseRouteClient, type CourseRouteClient } from "../courses/course-route-client";
import { ui } from "../design/ui";
import {
  usePaperReviewSession,
  type PaperReviewRequirementRef,
} from "../shared/paper-review-session";
import { sprintCourseMapHref } from "./sprint-plan-model";
import { TransitionLink as Link } from "../v3/motion/view-transition";

const STATUS_LABELS: Record<CourseRouteSnapshot["requirements"][number]["status"], string> = {
  unobserved: "待开始",
  needs_correction: "需要纠偏",
  assisted: "受助完成，待独立验证",
  needs_verification: "待验证",
  verified: "已有验证记录",
  blocked: "暂时受阻",
};

type RouteReader = Pick<CourseRouteClient, "read">;

type Props = {
  courseId: string;
  routeClient?: RouteReader;
  defaultOpen?: boolean;
};

/**
 * Collapsible 2A paper-review checklist panel shared with `/opening/map` via sessionStorage.
 * Keeps initial mount network-free when collapsed so existing sprint workflows stay fast.
 */
export function SprintPaperReviewPanel(props: Props) {
  return <CoursePaperReviewPanel key={props.courseId} {...props} />;
}

function CoursePaperReviewPanel({
  courseId,
  routeClient: suppliedRouteClient,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [loaded, setLoaded] = useState<{ snapshot: CourseRouteSnapshot; identity: string | null } | null>(null);
  const snapshot = loaded?.snapshot.courseId === courseId && loaded.identity === getVerifiedSessionNamespace()
    ? loaded.snapshot
    : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const [reload, setReload] = useState(0);
  const routeClient = useMemo(
    () => suppliedRouteClient ?? createCourseRouteClient(),
    [suppliedRouteClient],
  );

  const scope = useMemo(() => ({ kind: "course" as const, id: courseId }), [courseId]);
  const requirementRefs = useMemo<readonly PaperReviewRequirementRef[] | undefined>(
    () =>
      snapshot
        ? snapshot.requirements.map(item => ({
            id: item.requirement.id,
            revision: item.requirement.revision,
          }))
        : undefined,
    [snapshot],
  );
  const paperReview = usePaperReviewSession(snapshot ? scope : null, requirementRefs);

  const loadRoute = useCallback(async () => {
    const request = ++generation.current;
    const identity = getVerifiedSessionNamespace();
    const current = () => generation.current === request && getVerifiedSessionNamespace() === identity;
    setLoading(true);
    setError("");
    try {
      const next = await routeClient.read(courseId);
      if (!current()) return;
      if (next.courseId !== courseId) throw new Error("课程路线与当前课程不匹配。");
      setLoaded({ snapshot: next, identity });
    } catch (reason) {
      if (current()) {
        setError(userFacingMessage(reason, "读取课程要求清单失败，请重试。"));
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [courseId, routeClient]);

  useEffect(() => {
    return () => { generation.current++; };
  }, [courseId, routeClient]);

  useEffect(() => subscribeOpeningPrivacyChange(() => {
    generation.current++;
    setLoaded(null);
    setLoading(false);
    setError("");
    setReload(value => value + 1);
  }), []);

  useEffect(() => {
    if (!open || snapshot !== null) return;
    void loadRoute();
  }, [open, snapshot, loadRoute, reload]);

  const mapHref = sprintCourseMapHref(courseId);

  return (
    <section
      aria-label="本轮纸上核对清单"
      className="space-y-3 rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium text-text">
            本轮纸上已复习{snapshot ? `（第 ${paperReview.roundNumber} 轮 · 已标 ${paperReview.markedCount} 项）` : null}
          </h2>
          <p className="text-xs text-text-3">
            仅保存在当前浏览器标签页，与学习地图同步；不会替代线上独立验证记录。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className={ui.quiet} href={mapHref}>
            在学习地图中看全课
          </Link>
          <button
            type="button"
            className={ui.secondary}
            aria-expanded={open}
            aria-controls={`sprint-paper-review-${courseId}`}
            onClick={() => setOpen(value => !value)}
          >
            {open ? "收起纸上核对" : "展开纸上核对"}
          </button>
        </div>
      </div>

      {open ? (
        <div id={`sprint-paper-review-${courseId}`} className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={ui.quiet}
              disabled={!paperReview.canUndo}
              onClick={paperReview.undo}
            >
              撤销上一步
            </button>
            <button
              type="button"
              className={ui.quiet}
              disabled={paperReview.markedCount === 0}
              onClick={paperReview.startNextRound}
            >
              开启新一轮纸上核对
            </button>
            <button
              type="button"
              className={ui.quiet}
              disabled={loading}
              onClick={() => void loadRoute()}
            >
              {loading ? "读取中…" : "刷新要求清单"}
            </button>
          </div>

          {snapshot && !paperReview.storageAvailable ? (
            <p role="status" className="text-xs text-warn">浏览器暂未保存纸上勾选，当前标签页仍可继续核对。</p>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}

          {!snapshot && loading ? (
            <p className="text-xs text-text-2">正在读取课程要求清单…</p>
          ) : snapshot ? (
            snapshot.requirements.length === 0 ? (
              <p className="text-xs text-text-2">
                当前课程还没有已整理的学习要求，可先前往课程页确认学习范围。
              </p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {snapshot.requirements.map(item => {
                  const marked = paperReview.isMarked(
                    item.requirement.id,
                    item.requirement.revision,
                  );
                  return (
                    <li
                      key={item.requirement.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 accent-accent"
                          checked={marked}
                          onChange={() =>
                            paperReview.toggle(item.requirement.id, item.requirement.revision)
                          }
                        />
                        <span className="min-w-0 space-y-0.5">
                          <span className="block font-medium text-text">
                            {item.requirement.title}
                          </span>
                          <span className="block text-xs text-text-3">
                            {STATUS_LABELS[item.status]}
                            {marked ? " · 本轮纸上已过，仍待线上独立验证" : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
