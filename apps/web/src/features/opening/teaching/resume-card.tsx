"use client";

/**
 * V2-14 Experience — LearningResume resume-card.
 * Nest under TeachingWorkspace / Today continue entry (no new shell).
 * GET resume / POST checkpoint / PATCH status via OpeningApi.
 *
 * Locks: clientInit may be null (fail-soft); draft conflicts juxtapose server vs
 * local unsent (forbid LWW / silent overwrite / force overwrite); not ConversationResume;
 * summary independence (resume path must not wait on summarize); gate banners fail-soft.
 */

import type {
  LearningResume,
  TeachingActivity,
  TeachingActivityStatus,
  TeachingCheckpointSaveResult,
  TeachingContinuableAction,
  TeachingDraftAnchor,
  TeachingResumeJobGate,
  TeachingResumeMaterialsGate,
} from "@aistudy/contracts";
import { LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass, ui, tone } from "../design/ui";
import {
  teachingActivityGenerateStatusLabel,
  teachingActivityStatusLabel,
} from "./today-activity";

/** Local unsent draft buffer (non-authority; labeled until server ack). */
export type LocalUnsentDraft = {
  blockId: string;
  draftText: string;
  /** Optional local contentVersion hint when last edited. */
  contentVersion?: number;
};

export type ResumeDraftConflict = {
  kind: "draft_anchor_lost" | "version_conflict" | "juxtapose";
  lostBlockIds?: string[];
  message: string;
};

const ACTION_LABEL: Record<TeachingContinuableAction, string> = {
  continue_block: "继续当前块",
  edit_draft: "编辑草稿",
  command_why: "为什么",
  command_rephrase: "换种说法",
  command_expand: "展开",
  command_example: "举例",
  command_skip: "跳过",
  command_branch: "分支",
  command_return: "返回",
  wait_job: "等待生成",
  resolve_material: "处理材料",
};

const JOB_GATE_COPY: Record<TeachingResumeJobGate, string> = {
  ready: "生成任务可用或已明确失败/取消。",
  in_flight: "生成仍在进行中；结构化断点与草稿仍可读，请等待。",
  unknown: "生成状态未知；不会假装已就绪，草稿与思路仍保留。",
  stale: "生成结果可能已过期；请核对材料后再继续。",
};

const MATERIALS_GATE_COPY: Record<TeachingResumeMaterialsGate, string> = {
  available: "学习材料可用。",
  partial: "部分材料不可用；不会伪造缺失来源内容。",
  unavailable: "材料不可用或已撤回；请先处理材料后再继续主讲。",
};

export function continuableActionLabel(action: TeachingContinuableAction): string {
  return ACTION_LABEL[action];
}

export function jobGateBannerCopy(gate: TeachingResumeJobGate): string {
  return JOB_GATE_COPY[gate];
}

export function materialsGateBannerCopy(gate: TeachingResumeMaterialsGate): string {
  return MATERIALS_GATE_COPY[gate];
}

/** Thought-train depth summary for the card chrome. */
export function summarizeThoughtTrain(resume: Pick<LearningResume, "thoughtTrain">): {
  currentBlockId: string | null;
  branchDepth: number;
  commandLogCount: number;
  skippedCount: number;
} {
  const tt = resume.thoughtTrain;
  return {
    currentBlockId: tt.currentBlockId,
    branchDepth: tt.branchStack.length,
    commandLogCount: tt.commandLog.length,
    skippedCount: tt.skippedBlockIds.length,
  };
}

/** True when resume path must not wait on summarize (summary optional / skipped). */
export function resumeIgnoresSummary(
  resume: Pick<LearningResume, "summary"> | null | undefined,
): boolean {
  if (!resume?.summary) return true;
  return resume.summary.status === "skipped" || resume.summary.status === "failed" || resume.summary.status === "ready";
}

/** Never document LWW / force overwrite — conflicts require re-read + juxtaposition. */
export function checkpointConflictRequiresJuxtapose(
  result: TeachingCheckpointSaveResult | null | undefined,
): boolean {
  return Boolean(result && result.ok === false && result.mismatch === "draft_anchor_lost");
}

export function ResumeCardView({
  activityTitle,
  activityStatus,
  generateStatusLabel,
  resume,
  localUnsent = [],
  conflict = null,
  continueDisabled = false,
  continueBusy = false,
  pauseBusy = false,
  syncBusy = false,
  statusError = null,
  onContinue,
  onPause,
  onResumeStatus,
  onReread,
  onSyncUnsent,
}: {
  activityTitle: string;
  activityStatus: TeachingActivityStatus;
  generateStatusLabel: string;
  resume: LearningResume;
  localUnsent?: LocalUnsentDraft[];
  conflict?: ResumeDraftConflict | null;
  continueDisabled?: boolean;
  continueBusy?: boolean;
  pauseBusy?: boolean;
  syncBusy?: boolean;
  statusError?: string | null;
  onContinue?: () => void;
  onPause?: () => void;
  onResumeStatus?: () => void;
  onReread?: () => void;
  onSyncUnsent?: () => void;
}) {
  const thought = summarizeThoughtTrain(resume);
  const materialsGate = resume.gates.materials;
  const jobGate = resume.gates.job;
  const showMaterialsBanner = materialsGate !== "available";
  const showJobBanner = jobGate !== "ready";
  const serverDrafts = resume.drafts;
  const hasJuxtaposition =
    Boolean(conflict) || (localUnsent.length > 0 && serverDrafts.length > 0);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-5"
      aria-labelledby="teaching-resume-heading"
      data-teaching-resume-card="true"
      data-resume-activity-id={resume.activityId}
      data-resume-status={resume.status}
      data-resume-job-gate={jobGate}
      data-resume-materials-gate={materialsGate}
      data-resume-client-init={resume.clientInit ? "present" : "null"}
      data-content-version={resume.contentVersion}
      data-path-version={resume.pathVersion}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="teaching-resume-heading"
            className="text-sm font-semibold text-zinc-900"
          >
            学习断点 · 继续
          </h2>
          <p className="mt-1 break-words text-sm leading-6 text-zinc-700">
            {activityTitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`${ui.badge} ${tone.neutral}`} data-resume-status-badge="true">
            {teachingActivityStatusLabel(activityStatus)}
          </span>
          <span
            className={`${ui.badge} ${
              jobGate === "ready"
                ? tone.success
                : jobGate === "stale"
                  ? tone.danger
                  : tone.warning
            }`}
          >
            {generateStatusLabel}
          </span>
        </div>
      </header>

      <p className="mt-2 text-[11px] tabular-nums text-zinc-500">
        cv {resume.contentVersion} · pv {resume.pathVersion}
        {resume.clientInit
          ? " · clientInit 已就绪"
          : " · clientInit 暂缺（可先看断点，继续时再拉取）"}
      </p>

      {showJobBanner ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${
            jobGate === "stale" ? tone.danger : tone.warning
          }`}
          role="status"
          data-resume-gate-job={jobGate}
        >
          {jobGateBannerCopy(jobGate)}
        </div>
      ) : null}

      {resume.generateStatus === "needs_check" ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-teaching-needs-check="true"
        >
          主讲内容待核对：内容已发布，来源校验尚未完成。
        </div>
      ) : null}

      {showMaterialsBanner ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-resume-gate-materials={materialsGate}
        >
          {materialsGateBannerCopy(materialsGate)}
          {resume.gates.unavailableSourceIds.length ? (
            <span className="mt-1 block tabular-nums text-[11px] opacity-80">
              不可用来源 {resume.gates.unavailableSourceIds.length} 个
            </span>
          ) : null}
        </div>
      ) : null}

      <dl className="mt-4 grid gap-2 text-xs leading-5 text-zinc-600 sm:grid-cols-2">
        <div data-resume-thought-train="true">
          <dt className="text-zinc-400">思路深度</dt>
          <dd className="mt-1 text-zinc-800">
            分支 {thought.branchDepth} · 命令日志 {thought.commandLogCount} · 跳过{" "}
            {thought.skippedCount}
            {thought.currentBlockId ? (
              <span className="mt-0.5 block tabular-nums text-[11px] text-zinc-500">
                当前块 {thought.currentBlockId.slice(0, 8)}…
              </span>
            ) : (
              <span className="mt-0.5 block text-[11px] text-zinc-500">尚无当前块</span>
            )}
          </dd>
        </div>
        <div data-resume-open-problems="true">
          <dt className="text-zinc-400">未解决问题</dt>
          <dd className="mt-1 text-zinc-800">
            {resume.openProblems.length
              ? `${resume.openProblems.length} 项`
              : "无"}
            {resume.openProblems.length ? (
              <ul className="mt-1 space-y-0.5 text-[11px] text-zinc-500">
                {resume.openProblems.slice(0, 5).map((p) => (
                  <li key={`${p.problemId}-${p.reason}`} className="tabular-nums">
                    {p.problemId.slice(0, 8)}… · {p.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </dd>
        </div>
      </dl>

      <div className="mt-4" data-resume-drafts="true">
        <p className="text-xs font-medium text-zinc-600">草稿</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {serverDrafts.length === 0 && localUnsent.length === 0 ? (
            <span className="text-[11px] text-zinc-500">暂无服务端草稿</span>
          ) : null}
          {serverDrafts.map((d) => (
            <span
              key={`server-${d.blockId}`}
              className={`${ui.badge} ${tone.success}`}
              data-draft-chip="server"
              data-draft-block-id={d.blockId}
              title={d.draftText?.slice(0, 80) ?? ""}
            >
              服务端 · {d.blockId.slice(0, 8)}…
            </span>
          ))}
          {localUnsent.map((d) => (
            <span
              key={`unsent-${d.blockId}`}
              className={`${ui.badge} ${tone.warning}`}
              data-draft-chip="unsent"
              data-draft-block-id={d.blockId}
              title={d.draftText.slice(0, 80)}
            >
              未发送 · {d.blockId.slice(0, 8)}…
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-5 text-zinc-500">
          服务端草稿为权威；本地未发送草稿仅缓冲至同步成功，冲突时并排展示，禁止静默覆盖。
        </p>
      </div>

      {hasJuxtaposition || conflict ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-resume-draft-conflict={conflict?.kind ?? "juxtapose"}
          data-forbid-lww="true"
        >
          <p className="font-medium">草稿冲突 · 并排对照（禁止强制覆盖 / 禁止后写优先）</p>
          {conflict?.message ? <p className="mt-1">{conflict.message}</p> : null}
          {conflict?.lostBlockIds?.length ? (
            <p className="mt-1 tabular-nums text-[11px]">
              失效块：{conflict.lostBlockIds.map((id) => id.slice(0, 8)).join(", ")}…
            </p>
          ) : null}
          <div className="mt-2 grid gap-2 sm:grid-cols-2" data-resume-draft-juxtapose="true">
            <div className="rounded-md bg-white/70 px-2 py-1.5 ring-1 ring-zinc-900/5">
              <p className="text-[11px] font-medium text-zinc-700">服务端</p>
              {serverDrafts.length ? (
                <ul className="mt-1 space-y-1 text-[11px] text-zinc-600">
                  {serverDrafts.map((d) => (
                    <li key={`jx-s-${d.blockId}`}>
                      <span className="tabular-nums">{d.blockId.slice(0, 8)}…</span>
                      {d.draftText ? (
                        <span className="mt-0.5 block break-words text-zinc-500">
                          {d.draftText.slice(0, 120)}
                          {d.draftText.length > 120 ? "…" : ""}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[11px] text-zinc-500">无</p>
              )}
            </div>
            <div className="rounded-md bg-white/70 px-2 py-1.5 ring-1 ring-zinc-900/5">
              <p className="text-[11px] font-medium text-amber-900">本地未发送</p>
              {localUnsent.length ? (
                <ul className="mt-1 space-y-1 text-[11px] text-zinc-600">
                  {localUnsent.map((d) => (
                    <li key={`jx-l-${d.blockId}`}>
                      <span className="tabular-nums">{d.blockId.slice(0, 8)}…</span>
                      <span className="mt-0.5 block break-words text-zinc-500">
                        {d.draftText.slice(0, 120)}
                        {d.draftText.length > 120 ? "…" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[11px] text-zinc-500">无</p>
              )}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-zinc-600">
            请重新拉取断点后手动决定保留哪一侧；本页不提供「强制覆盖」。
          </p>
          {onReread ? (
            <button
              type="button"
              className={`${secondaryButtonClass} mt-2`}
              data-resume-reread="true"
              onClick={onReread}
            >
              <RefreshCw size={12} aria-hidden />
              重新拉取断点
            </button>
          ) : null}
        </div>
      ) : null}

      {resume.continuableActions.length ? (
        <div className="mt-4" data-resume-continuable="true">
          <p className="text-xs font-medium text-zinc-600">可立即继续</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {resume.continuableActions.map((action) => (
              <span
                key={action}
                className={`${ui.badge} ${tone.neutral}`}
                data-continuable-action={action}
              >
                {continuableActionLabel(action)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-[11px] leading-5 text-zinc-500" data-resume-summary-independence="true">
        断点恢复不依赖 AI 摘要
        {resume.summary
          ? `（摘要状态：${resume.summary.status}）`
          : "（未附带摘要）"}
        ；摘要失败不影响继续。
      </p>

      {statusError ? (
        <p className={`mt-2 text-xs ${tone.danger}`} role="alert">
          {statusError}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          data-resume-continue-cta="true"
          disabled={continueDisabled || continueBusy}
          onClick={onContinue}
        >
          {continueBusy ? (
            <>
              <LoaderCircle size={14} className="animate-spin" aria-hidden />
              加载中…
            </>
          ) : (
            "继续学习"
          )}
        </button>
        {activityStatus === "paused" ? (
          <button
            type="button"
            className={secondaryButtonClass}
            data-resume-unpause="true"
            disabled={pauseBusy || !onResumeStatus}
            onClick={onResumeStatus}
          >
            {pauseBusy ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : (
              <Play size={12} aria-hidden />
            )}
            恢复进行
          </button>
        ) : activityStatus === "active" ? (
          <button
            type="button"
            className={secondaryButtonClass}
            data-resume-pause="true"
            disabled={pauseBusy || !onPause}
            onClick={onPause}
          >
            {pauseBusy ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : (
              <Pause size={12} aria-hidden />
            )}
            暂停
          </button>
        ) : null}
        {localUnsent.length && onSyncUnsent ? (
          <button
            type="button"
            className={secondaryButtonClass}
            data-resume-sync-unsent="true"
            disabled={syncBusy}
            onClick={onSyncUnsent}
          >
            {syncBusy ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : null}
            同步未发送草稿
          </button>
        ) : null}
        {onReread && !conflict ? (
          <button
            type="button"
            className={ui.quiet}
            data-resume-reread="true"
            onClick={onReread}
          >
            <RefreshCw size={12} aria-hidden />
            刷新断点
          </button>
        ) : null}
      </div>
    </section>
  );
}

export type ResumeCardProps = {
  activity: TeachingActivity;
  /** Prefetched LearningResume; when omitted, card fetches via getTeachingResume. */
  resume?: LearningResume | null;
  localUnsent?: LocalUnsentDraft[];
  api?: OpeningApi;
  /** Called when user taps Continue — parent mounts TeachingWorkspace. */
  onContinue?: (resume: LearningResume) => void;
  /** Notify parent when pause/unpause updates activity. */
  onActivityUpdated?: (activity: TeachingActivity) => void;
  /** Notify parent when resume package is refreshed. */
  onResumeUpdated?: (resume: LearningResume) => void;
};

export function ResumeCard({
  activity,
  resume: resumeProp = null,
  localUnsent: localUnsentProp = [],
  api: apiProp,
  onContinue,
  onActivityUpdated,
  onResumeUpdated,
}: ResumeCardProps) {
  const api = apiProp ?? createOpeningApi();
  const [liveResume, setLiveResume] = useState<LearningResume | null>(resumeProp);
  const [localUnsent, setLocalUnsent] = useState<LocalUnsentDraft[]>(localUnsentProp);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">(
    resumeProp ? "ready" : "idle",
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ResumeDraftConflict | null>(null);
  const [continueBusy, setContinueBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState(activity);

  const applyResume = useCallback(
    (next: LearningResume) => {
      setLiveResume(next);
      setLoadState("ready");
      onResumeUpdated?.(next);
    },
    [onResumeUpdated],
  );

  const fetchResume = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    setConflict(null);
    try {
      const next = await api.getTeachingResume(activity.id);
      applyResume(next);
      return next;
    } catch (err) {
      setLoadState("error");
      setLoadError(err instanceof Error ? err.message : "读取学习断点失败");
      return null;
    }
  }, [activity.id, api, applyResume]);

  useEffect(() => {
    setLiveActivity(activity);
  }, [activity.id, activity.updatedAt, activity.status, activity.generateStatus, activity]);

  useEffect(() => {
    setLocalUnsent(localUnsentProp);
  }, [localUnsentProp]);

  useEffect(() => {
    if (resumeProp) {
      setLiveResume(resumeProp);
      setLoadState("ready");
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoadState("loading");
    setLoadError(null);
    setConflict(null);
    void api
      .getTeachingResume(activity.id)
      .then((next) => {
        if (cancelled) return;
        setLiveResume(next);
        setLoadState("ready");
        onResumeUpdated?.(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState("error");
        setLoadError(err instanceof Error ? err.message : "读取学习断点失败");
      });
    return () => {
      cancelled = true;
    };
    // Fetch only when activity identity changes and no prefetched resume.
    // Intentionally omit fetchResume identity to avoid request loops.
  }, [activity.id, resumeProp, api]);

  const handleContinue = useCallback(async () => {
    if (!liveResume) return;
    setContinueBusy(true);
    setStatusError(null);
    try {
      onContinue?.(liveResume);
    } finally {
      setContinueBusy(false);
    }
  }, [liveResume, onContinue]);

  const handlePause = useCallback(async () => {
    setPauseBusy(true);
    setStatusError(null);
    try {
      const updated = await api.patchTeachingActivityStatus(activity.id, {
        status: "paused",
        expectedUpdatedAt: liveActivity.updatedAt,
      });
      setLiveActivity(updated);
      onActivityUpdated?.(updated);
      await fetchResume();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "暂停失败");
    } finally {
      setPauseBusy(false);
    }
  }, [activity.id, api, fetchResume, liveActivity.updatedAt, onActivityUpdated]);

  const handleUnpause = useCallback(async () => {
    setPauseBusy(true);
    setStatusError(null);
    try {
      const updated = await api.patchTeachingActivityStatus(activity.id, {
        status: "active",
        expectedUpdatedAt: liveActivity.updatedAt,
      });
      setLiveActivity(updated);
      onActivityUpdated?.(updated);
      await fetchResume();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "恢复失败");
    } finally {
      setPauseBusy(false);
    }
  }, [activity.id, api, fetchResume, liveActivity.updatedAt, onActivityUpdated]);

  const handleSyncUnsent = useCallback(async () => {
    if (!liveResume || localUnsent.length === 0) return;
    setSyncBusy(true);
    setStatusError(null);
    setConflict(null);
    try {
      const drafts: TeachingDraftAnchor[] = localUnsent.map((d) => ({
        blockId: d.blockId,
        contentVersion: d.contentVersion ?? liveResume.contentVersion,
        draftText: d.draftText,
      }));
      const result = await api.postTeachingCheckpoint(activity.id, {
        expectedVersion: liveResume.contentVersion,
        drafts,
      });
      if (checkpointConflictRequiresJuxtapose(result)) {
        const lost = result.ok === false ? result.lostBlockIds : [];
        setConflict({
          kind: "draft_anchor_lost",
          lostBlockIds: lost,
          message:
            "部分草稿锚点在服务端已失效。请并排对照后手动处理；禁止强制覆盖。",
        });
        await fetchResume();
        return;
      }
      if (result.ok) {
        setLocalUnsent([]);
        await fetchResume();
      }
    } catch (err) {
      setConflict({
        kind: "version_conflict",
        message:
          err instanceof Error
            ? `${err.message} — 已禁止静默覆盖；请对照服务端与本地未发送草稿。`
            : "版本冲突；请对照服务端与本地未发送草稿，禁止强制覆盖。",
      });
      await fetchResume();
    } finally {
      setSyncBusy(false);
    }
  }, [activity.id, api, fetchResume, liveResume, localUnsent]);

  if (loadState === "loading" || loadState === "idle") {
    return (
      <section
        className="flex h-full min-h-0 flex-col items-center justify-center px-5 py-10"
        data-teaching-resume-card="loading"
      >
        <LoaderCircle size={18} className="animate-spin text-zinc-400" aria-hidden />
        <p className="mt-3 text-xs text-zinc-500">正在读取学习断点…</p>
      </section>
    );
  }

  if (loadState === "error" || !liveResume) {
    return (
      <section
        className="flex h-full min-h-0 flex-col px-5 py-5"
        data-teaching-resume-card="error"
        role="alert"
      >
        <h2 className="text-sm font-semibold text-zinc-900">学习断点暂时无法读取</h2>
        <p className={`mt-2 text-xs leading-5 ${tone.danger}`}>
          {loadError ?? "未知错误"}
        </p>
        <p className="mt-2 text-[11px] text-zinc-500">
          不会伪造讲义或聊天恢复；可稍后重试。
        </p>
        <button
          type="button"
          className={`${secondaryButtonClass} mt-4 self-start`}
          data-resume-reread="true"
          onClick={() => void fetchResume()}
        >
          <RefreshCw size={12} aria-hidden />
          重新读取
        </button>
      </section>
    );
  }

  return (
    <ResumeCardView
      activityTitle={liveActivity.intentSummary}
      activityStatus={liveActivity.status}
      generateStatusLabel={teachingActivityGenerateStatusLabel(liveActivity.generateStatus)}
      resume={liveResume}
      localUnsent={localUnsent}
      conflict={conflict}
      continueBusy={continueBusy}
      pauseBusy={pauseBusy}
      syncBusy={syncBusy}
      statusError={statusError}
      onContinue={() => void handleContinue()}
      onPause={liveActivity.status === "active" ? () => void handlePause() : undefined}
      onResumeStatus={
        liveActivity.status === "paused" ? () => void handleUnpause() : undefined
      }
      onReread={() => void fetchResume()}
      onSyncUnsent={localUnsent.length ? () => void handleSyncUnsent() : undefined}
    />
  );
}
