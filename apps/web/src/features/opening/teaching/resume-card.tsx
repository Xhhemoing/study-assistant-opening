"use client";
import { userFacingMessage } from "../../../lib/user-facing-error";

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
import { ThinkingLine } from "../v3/motion/feedback";
import { LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass, ui, tone } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
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

const EMPTY_LOCAL_DRAFTS: LocalUnsentDraft[] = [];

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
  in_flight: "正在准备讲解",
  unknown: "暂时无法确认讲解是否准备好，可重新读取",
  stale: "生成结果可能已过期；请核对材料后再继续。",
};

const MATERIALS_GATE_COPY: Record<TeachingResumeMaterialsGate, string> = {
  available: "学习材料可用。",
  partial: "部分材料暂时无法读取，请检查材料后继续。",
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
  localUnsent = EMPTY_LOCAL_DRAFTS,
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
  const diagnostics = useDiagnosticsEnabled();
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
        <h2
          id="teaching-resume-heading"
          className="min-w-0 break-words text-ui-lg font-semibold text-text"
        >
          <span className="sr-only">学习位置：</span>{activityTitle}
        </h2>
        {activityStatus !== "active" ? <span className={`${ui.badge} ${tone.neutral}`} data-resume-status-badge="true">
          {teachingActivityStatusLabel(activityStatus)}
        </span> : null}
      </header>

      {showJobBanner ? (
        jobGate === "stale" ? <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.danger}`}
          role="status"
          data-resume-gate-job={jobGate}
        >
          {jobGateBannerCopy(jobGate)}
        </div> : <p className="mt-2 text-meta text-text-2" data-resume-gate-job={jobGate} title={generateStatusLabel}>
          {jobGate === "in_flight" ? <ThinkingLine label={jobGateBannerCopy(jobGate)} /> : jobGateBannerCopy(jobGate)}
        </p>
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
            <span className="mt-1 block tabular-nums text-xs">
              不可用来源 {resume.gates.unavailableSourceIds.length} 个
            </span>
          ) : null}
        </div>
      ) : null}

      {serverDrafts.length || localUnsent.length ? <div className="mt-4 text-xs leading-5 text-text-2" data-resume-drafts="true">
        {serverDrafts.length ? <p>{serverDrafts.length} 段内容已保存</p> : null}
        {localUnsent.length ? <p className="text-warn" role="status">{localUnsent.length} 段内容尚未保存</p> : null}
        {localUnsent.length && !hasJuxtaposition ? <details className="mt-2">
          <summary className="cursor-pointer">查看未保存内容</summary>
          <ul className="mt-2 space-y-2">{localUnsent.map(d => <li key={d.blockId} className="whitespace-pre-wrap break-words">{d.draftText}</li>)}</ul>
        </details> : null}
      </div> : null}
      {resume.openProblems.length ? <p className="mt-2 text-xs leading-5 text-text-2">还有 {resume.openProblems.length} 道题可以继续。</p> : null}

      {hasJuxtaposition || conflict ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-resume-draft-conflict={conflict?.kind ?? "juxtapose"}
          data-forbid-lww="true"
        >
          <p className="font-medium">{conflict ? "保存未完成，请对照内容" : "有内容尚未保存"}</p>
          <p className="mt-1">{conflict?.kind === "draft_anchor_lost" ? "部分内容的位置已变化，你写的内容仍保留在下面。" : "已保存的内容和本次输入都保留在下面，可先对照再继续。"}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2" data-resume-draft-juxtapose="true">
            <div className="rounded-md bg-surface px-2 py-1.5 ring-1 ring-line">
              <p className="text-xs font-medium text-text-2">已保存内容</p>
              {serverDrafts.length ? (
                <ul className="mt-1 space-y-1 text-xs text-text-2">
                  {serverDrafts.map((d) => (
                    <li key={`jx-s-${d.blockId}`}>
                      {d.draftText ? (
                        <span className="block whitespace-pre-wrap break-words text-text-3">{d.draftText}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-text-3">无</p>
              )}
            </div>
            <div className="rounded-md bg-surface px-2 py-1.5 ring-1 ring-line">
              <p className="text-xs font-medium text-warn">本次未保存内容</p>
              {localUnsent.length ? (
                <ul className="mt-1 space-y-1 text-xs text-text-2">
                  {localUnsent.map((d) => (
                    <li key={`jx-l-${d.blockId}`}>
                      <span className="block whitespace-pre-wrap break-words text-text-3">{d.draftText}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-text-3">无</p>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-text-2">
            请重新读取后，在学习内容中整理需要保留的文字。两侧内容不会自动覆盖。
          </p>
          {onReread ? (
            <button
              type="button"
              className={`${secondaryButtonClass} mt-2`}
              data-resume-reread="true"
              onClick={onReread}
            >
              <RefreshCw size={12} aria-hidden />
              重新读取已保存内容
            </button>
          ) : null}
        </div>
      ) : null}

      {diagnostics ? <details className="mt-4 rounded-lg border border-line px-3 py-2 text-xs leading-5 text-text-3" data-resume-diagnostics="true">
        <summary className="cursor-pointer font-medium">诊断信息</summary>
        <div className="mt-3 space-y-3">
          <p data-resume-thought-train="true">分支 {thought.branchDepth} · 命令日志 {thought.commandLogCount} · 跳过 {thought.skippedCount}<span className="block break-all">当前块：{thought.currentBlockId ?? "无"}</span></p>
          <div data-resume-open-problems="true">未解决问题：{resume.openProblems.length}<ul>{resume.openProblems.map(p => <li key={`${p.problemId}-${p.reason}`} className="break-all">{p.problemId} · {p.reason}</li>)}</ul></div>
          <div className="flex flex-wrap gap-1.5">
            {serverDrafts.map(d => <span key={`server-${d.blockId}`} className={`${ui.badge} ${tone.success}`} data-draft-chip="server" data-draft-block-id={d.blockId}>服务端 · {d.blockId}</span>)}
            {localUnsent.map(d => <span key={`unsent-${d.blockId}`} className={`${ui.badge} ${tone.warning}`} data-draft-chip="unsent" data-draft-block-id={d.blockId}>未发送 · {d.blockId}</span>)}
          </div>
          <p>服务端草稿为权威；本地未发送草稿仅缓冲至同步成功，冲突时并排展示，禁止静默覆盖。</p>
          {conflict?.message ? <p>{conflict.message}</p> : null}
          {conflict?.lostBlockIds?.length ? <p className="break-all">失效块：{conflict.lostBlockIds.join(", ")}</p> : null}
          {resume.continuableActions.length ? <div className="flex flex-wrap gap-1.5" data-resume-continuable="true">{resume.continuableActions.map(action => <span key={action} className={`${ui.badge} ${tone.neutral}`} data-continuable-action={action}>{continuableActionLabel(action)}</span>)}</div> : null}
          <p data-resume-summary-independence="true">断点恢复不依赖 AI 摘要（摘要状态：{resume.summary?.status ?? "未附带"}）；摘要失败不影响继续。</p>
        </div>
      </details> : null}

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
            保存未保存内容
          </button>
        ) : null}
        {onReread && !hasJuxtaposition ? (
          <button
            type="button"
            className={ui.quiet}
            data-resume-reread="true"
            onClick={onReread}
          >
            <RefreshCw size={12} aria-hidden />
            重新读取
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
  localUnsent: localUnsentProp = EMPTY_LOCAL_DRAFTS,
  api: apiProp,
  onContinue,
  onActivityUpdated,
  onResumeUpdated,
}: ResumeCardProps) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const requestScope = useMemo(() => ({ active: true }), [activity.id, api]);
  useEffect(() => {
    requestScope.active = true;
    return () => { requestScope.active = false; };
  }, [requestScope]);
  const [liveResume, setLiveResume] = useState<LearningResume | null>(resumeProp);
  // Props remain the source of local drafts. Only the exact acknowledged
  // snapshots disappear; a new edit during an in-flight save stays unsent.
  const [acknowledged, setAcknowledged] = useState<{
    activityId: string;
    drafts: Array<LocalUnsentDraft & { contentVersion: number }>;
  } | null>(null);
  const localUnsent = useMemo(() => localUnsentProp.filter(draft => {
    const version = draft.contentVersion ?? liveResume?.contentVersion;
    const matchesDraft = (saved: TeachingDraftAnchor) => saved.blockId === draft.blockId
      && saved.draftText === draft.draftText && saved.contentVersion === version;
    const wasAcknowledged = acknowledged?.activityId === activity.id && acknowledged.drafts.some(matchesDraft);
    // A previous save cannot suppress a new draft after the server content changes.
    const matchesServer = liveResume?.activityId === activity.id && liveResume.drafts.some(matchesDraft);
    return !wasAcknowledged || !matchesServer;
  }), [activity.id, acknowledged, liveResume, localUnsentProp]);
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
    try {
      const next = await api.getTeachingResume(activity.id);
      if (!requestScope.active) return null;
      applyResume(next);
      return next;
    } catch (err) {
      if (!requestScope.active) return null;
      setLoadState("error");
      setLoadError(userFacingMessage(err, "读取学习位置失败"));
      return null;
    }
  }, [activity.id, api, applyResume, requestScope]);

  useEffect(() => {
    setLiveActivity(activity);
  }, [activity]);

  useEffect(() => {
    setConflict(null);
    setStatusError(null);
    setPauseBusy(false);
    setSyncBusy(false);
  }, [activity.id]);

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
        setLoadError(userFacingMessage(err, "读取学习位置失败"));
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
      if (!requestScope.active) return;
      setLiveActivity(updated);
      onActivityUpdated?.(updated);
      await fetchResume();
    } catch (err) {
      if (requestScope.active) setStatusError(userFacingMessage(err, "暂停失败"));
    } finally {
      if (requestScope.active) setPauseBusy(false);
    }
  }, [activity.id, api, fetchResume, liveActivity.updatedAt, onActivityUpdated, requestScope]);

  const handleUnpause = useCallback(async () => {
    setPauseBusy(true);
    setStatusError(null);
    try {
      const updated = await api.patchTeachingActivityStatus(activity.id, {
        status: "active",
        expectedUpdatedAt: liveActivity.updatedAt,
      });
      if (!requestScope.active) return;
      setLiveActivity(updated);
      onActivityUpdated?.(updated);
      await fetchResume();
    } catch (err) {
      if (requestScope.active) setStatusError(userFacingMessage(err, "恢复失败"));
    } finally {
      if (requestScope.active) setPauseBusy(false);
    }
  }, [activity.id, api, fetchResume, liveActivity.updatedAt, onActivityUpdated, requestScope]);

  const handleSyncUnsent = useCallback(async () => {
    if (!liveResume || localUnsent.length === 0) return;
    setSyncBusy(true);
    setStatusError(null);
    setConflict(null);
    try {
      const drafts = localUnsent.map((d) => ({
        blockId: d.blockId,
        contentVersion: d.contentVersion ?? liveResume.contentVersion,
        draftText: d.draftText,
      })) satisfies TeachingDraftAnchor[];
      const result = await api.postTeachingCheckpoint(activity.id, {
        expectedVersion: liveResume.contentVersion,
        drafts,
      });
      if (!requestScope.active) return;
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
        setAcknowledged(previous => ({
          activityId: activity.id,
          drafts: [
            ...(previous?.activityId === activity.id ? previous.drafts.filter(saved => !localUnsent.some(draft => draft.blockId === saved.blockId)) : []),
            ...drafts,
          ],
        }));
        await fetchResume();
      }
    } catch (err) {
      if (!requestScope.active) return;
      setConflict({
        kind: "version_conflict",
        message:
          err instanceof Error
            ? `${err.message} — 已禁止静默覆盖；请对照服务端与本地未发送草稿。`
            : "版本冲突；请对照服务端与本地未发送草稿，禁止强制覆盖。",
      });
      await fetchResume();
    } finally {
      if (requestScope.active) setSyncBusy(false);
    }
  }, [activity.id, api, fetchResume, liveResume, localUnsent, requestScope]);

  if (loadState === "loading" || loadState === "idle") {
    return (
      <section
        className="flex h-full min-h-0 flex-col items-center justify-center px-5 py-10"
        data-teaching-resume-card="loading"
      >
        <LoaderCircle size={18} className="animate-spin text-text-3" aria-hidden />
        <p className="mt-3 text-xs text-text-3">正在读取学习位置…</p>
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
        <h2 className="text-sm font-semibold text-text">学习位置暂时无法读取</h2>
        <p className={`mt-2 text-xs leading-5 ${tone.danger}`}>
          {loadError ?? "未知错误"}
        </p>
        <p className="mt-2 text-xs text-text-3">
          请稍后重新读取，已保存的学习内容会保留。
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
      generateStatusLabel={teachingActivityGenerateStatusLabel(liveActivity.generateStatus, { contentVersion: liveActivity.contentVersion })}
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
