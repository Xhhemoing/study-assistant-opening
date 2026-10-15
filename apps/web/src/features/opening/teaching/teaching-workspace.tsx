"use client";

import Link from "next/link";
import { ChevronDown, BookOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActivitySpecClientInit,
  LearningResume,
  TeachingActivity,
  TeachingCommandConflict,
  TeachingCommandSuccess,
} from "@aistudy/contracts";
import { ui, tone } from "../design/ui";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { BlockRenderer } from "./block-renderer";
import {
  BlockCommands,
  isBranchStackEmpty,
} from "./block-commands";
import {
  isKnownSchemaVersion,
  readSchemaVersion,
} from "./component-catalog";
import {
  canRequestTeachingCompile,
  formatActivityUpdatedAt,
  teachingActivityGenerateStatusLabel,
  teachingActivityStatusLabel,
} from "./today-activity";
import { PreferenceControls } from "./preference-controls";
import { ResumeCard, type LocalUnsentDraft } from "./resume-card";
import { ActivityEndControl } from "./activity-end-control";

export type TeachingWorkspaceProps = {
  activity: TeachingActivity;
  clientInit: ActivitySpecClientInit;
  assistantHref?: string | null;
  timeZone?: string;
  /** Optional OpeningApi inject (tests). */
  api?: OpeningApi;
  onActivityUpdated?: (activity: TeachingActivity) => void;
  /** 「再学一节」 created the next section; the page switches to it. */
  onNextActivity?: (activity: TeachingActivity) => void;
};

/**
 * Usable gate: ready or needs_check with published (non-empty) blocks.
 * needs_check is admitted for learning with an explicit 「待核对」 affordance;
 * failed/cancelled/stale/empty still refuse.
 */
export function isTeachingWorkspaceContentUsable(
  activity: Pick<TeachingActivity, "generateStatus">,
  clientInit: ActivitySpecClientInit | null | undefined,
): boolean {
  if (activity.generateStatus !== "ready" && activity.generateStatus !== "needs_check") {
    return false;
  }
  if (!clientInit) return false;
  if (!Array.isArray(clientInit.blocks) || clientInit.blocks.length === 0) return false;
  return true;
}

function ExpandSection({
  id,
  title,
  children,
  defaultOpen = false,
}: {
  id: string;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-zinc-100 pt-3" data-expand={id}>
      <button
        type="button"
        className={`${ui.quiet} w-full justify-between px-0`}
        aria-expanded={open}
        aria-controls={`teaching-expand-${id}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{title}</span>
        <ChevronDown
          size={14}
          aria-hidden
          className={open ? "rotate-180 transition-transform" : "transition-transform"}
        />
      </button>
      {open ? (
        <div id={`teaching-expand-${id}`} className="mt-2 space-y-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function TeachingWorkspace({
  activity,
  clientInit: clientInitProp,
  assistantHref,
  timeZone = "Asia/Shanghai",
  api: apiProp,
  onActivityUpdated,
  onNextActivity,
}: TeachingWorkspaceProps) {
  const api = apiProp ?? createOpeningApi();
  const [liveActivity, setLiveActivity] = useState(activity);
  const [liveInit, setLiveInit] = useState<ActivitySpecClientInit>(clientInitProp);
  const [contentVersion, setContentVersion] = useState(
    clientInitProp.contentVersion ?? activity.contentVersion,
  );
  const [pathVersion, setPathVersion] = useState(activity.pathVersion);
  const [workspaceConflict, setWorkspaceConflict] =
    useState<TeachingCommandConflict | null>(null);
  const [rereadError, setRereadError] = useState<string | null>(null);

  // Sync when parent passes a new activity/init identity (e.g. today dashboard reload).
  useEffect(() => {
    setLiveActivity(activity);
    setLiveInit(clientInitProp);
    setContentVersion(clientInitProp.contentVersion ?? activity.contentVersion);
    setPathVersion(activity.pathVersion);
  }, [
    activity.id,
    activity.contentVersion,
    activity.pathVersion,
    activity.updatedAt,
    clientInitProp.id,
    clientInitProp.version,
    clientInitProp.contentVersion,
    clientInitProp.updatedAt,
    clientInitProp,
  ]);

  const schemaVersion = useMemo(() => readSchemaVersion(liveInit), [liveInit]);
  const schemaOk = isKnownSchemaVersion(schemaVersion);
  const orderedBlocks = useMemo(
    () => [...liveInit.blocks].sort((a, b) => a.position - b.position),
    [liveInit.blocks],
  );
  const returnDisabled = isBranchStackEmpty(liveInit.checkpointJson ?? {});
  const generateTone =
    activity.generateStatus === "failed" || activity.generateStatus === "stale"
      ? tone.danger
      : activity.generateStatus === "ready"
        ? tone.success
        : activity.generateStatus === "needs_check"
          ? tone.warning
          : tone.neutral;

  const applySuccess = useCallback((result: TeachingCommandSuccess) => {
    setWorkspaceConflict(null);
    setContentVersion(result.contentVersion);
    setPathVersion(result.pathVersion);
    if (result.clientInit) {
      setLiveInit(result.clientInit);
    } else if (result.checkpointJson) {
      setLiveInit((prev) => ({
        ...prev,
        contentVersion: result.contentVersion,
        checkpointJson: result.checkpointJson,
      }));
    }
  }, []);

  const handleConflict = useCallback((conflict: TeachingCommandConflict) => {
    setWorkspaceConflict(conflict);
  }, []);

  const reread = useCallback(async () => {
    setRereadError(null);
    const [freshInit, freshActivity] = await Promise.all([
      api.getTeachingClientInit(activity.id),
      api.getTeachingActivity(activity.id),
    ]);
    setLiveInit(freshInit);
    setContentVersion(freshInit.contentVersion ?? freshActivity.contentVersion);
    setPathVersion(freshActivity.pathVersion);
    setWorkspaceConflict(null);
  }, [activity.id, api]);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-5"
      aria-labelledby="teaching-workspace-heading"
      data-teaching-workspace="true"
      data-content-version={contentVersion}
      data-path-version={pathVersion}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="teaching-workspace-heading"
            className="flex items-center gap-2 text-sm font-semibold text-zinc-900"
          >
            <BookOpen size={16} aria-hidden className="shrink-0 text-emerald-700" />
            当前 AI 教学
          </h2>
          <p className="mt-1 break-words text-sm leading-6 text-zinc-700">
            {activity.intentSummary}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`${ui.badge} ${tone.neutral}`}>
            {teachingActivityStatusLabel(liveActivity.status)}
          </span>
          <span className={`${ui.badge} ${generateTone}`}>
            {teachingActivityGenerateStatusLabel(activity.generateStatus, { contentVersion: activity.contentVersion })}
          </span>
        </div>
      </header>

      {activity.generateStatus === "needs_check" ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-teaching-needs-check="true"
        >
          主讲内容待核对：内容已发布，来源校验尚未完成，可先学习。
        </div>
      ) : null}

      <p className="mt-2 text-[11px] tabular-nums text-zinc-500">
        最近更新 {formatActivityUpdatedAt(activity.updatedAt, timeZone)}
        {liveInit.verificationStatus
          ? ` · 校验 ${liveInit.verificationStatus}`
          : null}
        {` · cv ${contentVersion} · pv ${pathVersion}`}
      </p>

      {workspaceConflict ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-workspace-command-conflict={workspaceConflict.conflict}
        >
          教学命令冲突（{workspaceConflict.conflict}）。请重新拉取合并，勿强制覆盖。
        </div>
      ) : null}
      {rereadError ? (
        <p className={`mt-2 text-xs ${tone.danger}`} role="alert">
          {rereadError}
        </p>
      ) : null}

      {!schemaOk ? (
        <div
          className={`mt-4 rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="status"
          data-workspace-schema-fail="true"
        >
          教学内容 schema 版本不受支持（{schemaVersion}）。今日工作台仍可用；请稍后重试或改用活动摘要。
        </div>
      ) : null}

      {schemaOk ? (
        <div className="mt-4 space-y-4" data-teaching-blocks="true">
          {orderedBlocks.map((block) => (
            <div key={block.blockId} className="space-y-1">
              <BlockRenderer
                block={block}
                schemaVersion={schemaVersion}
                sourceRefs={liveInit.sourceRefs}
                attemptContext={{ ...liveActivity, contentVersion, onCourseAssociated: (next) => { setLiveActivity(next); onActivityUpdated?.(next); } }}
              />
              {liveActivity.status !== "completed" ? <BlockCommands
                activityId={activity.id}
                blockId={block.blockId}
                contentVersion={contentVersion}
                pathVersion={pathVersion}
                returnDisabled={returnDisabled}
                api={api}
                onSuccess={applySuccess}
                onConflict={handleConflict}
                onReread={async () => {
                  try {
                    await reread();
                  } catch (err) {
                    setRereadError(
                      err instanceof Error ? err.message : "重新拉取失败",
                    );
                    throw err;
                  }
                }}
              /> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 space-y-1">
        <ExpandSection id="outline" title="提纲（按需展开）">
          {liveInit.goals.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-zinc-700">
              {liveInit.goals.map((g) => (
                <li key={g.goalId}>{g.statement}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-zinc-500">暂无提纲目标元数据。</p>
          )}
        </ExpandSection>

        <ExpandSection id="materials" title="原材料 / 引用（按需展开）">
          {liveInit.sourceRefs.length ? (
            <ul className="space-y-1.5 text-xs leading-5 text-zinc-700">
              {liveInit.sourceRefs.map((ref, i) => (
                <li
                  key={`${ref.sourceId}-${i}`}
                  className="rounded-md bg-zinc-50 px-2 py-1.5 ring-1 ring-zinc-900/5"
                >
                  <span className="font-medium">来源</span>{" "}
                  <span className="tabular-nums">{ref.sourceId.slice(0, 8)}…</span>
                  {ref.page != null ? <span className="ml-2">p.{ref.page}</span> : null}
                  {ref.chunkId ? (
                    <span className="ml-2 text-zinc-500">
                      chunk {String(ref.chunkId).slice(0, 8)}…
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-zinc-500">暂无 sourceRefs。</p>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">
            完整课件阅读器为次要入口；学习无需先打开原阅读器。
          </p>
        </ExpandSection>

        <ExpandSection id="drafts" title="草稿（按需展开）">
          <p className="text-[11px] leading-5 text-zinc-600">
            草稿锚点保存在服务端 checkpoint；隐藏答案不会预加载到本页。教学命令成功后会保留仍存在的草稿，不会静默覆盖。
            {liveInit.checkpointJson && Object.keys(liveInit.checkpointJson).length
              ? ` 已有 checkpoint 字段 ${Object.keys(liveInit.checkpointJson).length} 个。`
              : " 当前无个人草稿。"}
          </p>
        </ExpandSection>
      </div>

      <div className="mt-4">
        <ExpandSection id="intervention-prefs" title="本课介入偏好（临时 · 按需展开）">
          <PreferenceControls
            scope="session"
            activityId={activity.id}
            courseId={activity.courseId}
            expectedUpdatedAt={activity.updatedAt}
            compact
          />
        </ExpandSection>
      </div>

      <p className="mt-4">
        <Link href={assistantHref ?? "/opening/assistant"} className={ui.quiet}>
          打开自由对话（次要）
        </Link>
      </p>
      <div className="mt-5"><ActivityEndControl activity={liveActivity} api={api} onActivityUpdated={(next) => { setLiveActivity(next); onActivityUpdated?.(next); }} {...(onNextActivity ? { onNextActivity } : {})} /></div>
    </section>
  );
}


/** wait_init action visibility — no endless client-init retry when nothing is in flight. */
export function waitInitActionVisibility(input: {
  jobGate: "ready" | "in_flight" | "unknown" | "stale" | null | undefined;
  canCompile: boolean;
}): { showCompile: boolean; showRetryFetch: boolean; showBack: boolean } {
  const inFlight = input.jobGate === "in_flight";
  return {
    showCompile: input.canCompile,
    showRetryFetch: inFlight,
    showBack: true,
  };
}

/**
 * What a resume read means for a learner who asked to go straight into the lecture:
 * open it, keep waiting for the running compile, read client-init once, or stop and
 * show the manual actions (failed, cancelled, unknown outcome — never poll those).
 */
export function autoOpenStep(resume: Pick<LearningResume, "clientInit" | "generateStatus" | "gates">): "open" | "wait" | "fetch_init" | "stop" {
  if (resume.clientInit && isTeachingWorkspaceContentUsable({ generateStatus: resume.generateStatus }, resume.clientInit)) return "open";
  if (resume.gates.job === "in_flight") return "wait";
  if (resume.generateStatus === "ready" || resume.generateStatus === "needs_check") return "fetch_init";
  return "stop";
}

/** Poll cadence while the lecture is being prepared; bounded so a stuck job ends in manual actions. */
export const AUTO_OPEN_POLL_MS = 3000;
export const AUTO_OPEN_MAX_POLLS = 60;

/**
 * V2-14 continue entry: show LearningResume card, then mount TeachingWorkspace.
 * Prefers resume.clientInit when present; null clientInit → re-fetch / wait (fail-soft).
 * Does **not** route through ConversationResume.
 */
export type TeachingContinueEntryProps = {
  activity: TeachingActivity;
  /** Prefetched resume (optional; card fetches if omitted). */
  resume?: LearningResume | null;
  localUnsent?: LocalUnsentDraft[];
  assistantHref?: string | null;
  timeZone?: string;
  api?: OpeningApi;
  /** When true, skip card and open workspace immediately if usable clientInit given. */
  startInWorkspace?: boolean;
  initialClientInit?: ActivitySpecClientInit | null;
  onActivityUpdated?: (activity: TeachingActivity) => void;
  onNextActivity?: (activity: TeachingActivity) => void;
  /**
   * When false, hide 「生成主讲内容」 (compiler off / capabilities).
   * Default true preserves prior call sites; Today wires the real switch.
   */
  teachingCompileEnabled?: boolean;
};

export function TeachingContinueEntry({
  activity: activityProp,
  resume: resumeProp = null,
  localUnsent,
  assistantHref,
  timeZone = "Asia/Shanghai",
  api: apiProp,
  startInWorkspace = false,
  initialClientInit = null,
  onActivityUpdated,
  onNextActivity,
  teachingCompileEnabled = true,
}: TeachingContinueEntryProps) {
  const api = apiProp ?? createOpeningApi();
  const [activity, setActivity] = useState(activityProp);
  // Right after a create the parent may still hold the previous activity's content.
  const ownInit = initialClientInit?.activityId === activityProp.id ? initialClientInit : null;
  const [phase, setPhase] = useState<"card" | "workspace" | "wait_init">(
    startInWorkspace &&
      ownInit &&
      isTeachingWorkspaceContentUsable(activityProp, ownInit)
      ? "workspace"
      : "card",
  );
  const [workspaceInit, setWorkspaceInit] = useState<ActivitySpecClientInit | null>(ownInit);
  const [waitError, setWaitError] = useState<string | null>(null);
  const [waitBusy, setWaitBusy] = useState(false);
  const [liveResume, setLiveResume] = useState<LearningResume | null>(resumeProp);
  /** Set by 「开始学习」/「开始任务主讲」: open the lecture by itself once it is ready. */
  const autoOpen = useRef(startInWorkspace);
  const polls = useRef(0);
  // Parent callbacks are inline; keep the poll timer independent of re-renders.
  const onActivityUpdatedRef = useRef(onActivityUpdated);
  onActivityUpdatedRef.current = onActivityUpdated;
  const [pollExhausted, setPollExhausted] = useState(false);

  useEffect(() => {
    setActivity(activityProp);
  }, [activityProp]);

  useEffect(() => {
    // The parent may still hold the previous activity's resume right after a create.
    if (resumeProp && resumeProp.activityId === activityProp.id) setLiveResume(resumeProp);
  }, [resumeProp, activityProp.id]);

  const openWorkspaceFromResume = useCallback(
    async (resume: LearningResume) => {
      setLiveResume(resume);
      setWaitError(null);

      // Prefer resume.clientInit when present and usable.
      if (
        resume.clientInit &&
        isTeachingWorkspaceContentUsable(
          { generateStatus: resume.generateStatus },
          resume.clientInit,
        )
      ) {
        setWorkspaceInit(resume.clientInit);
        setPhase("workspace");
        return;
      }

      // clientInit null or not usable — fail-soft: try client-init fetch / show wait.
      if (resume.gates.job === "in_flight" || resume.gates.job === "unknown") {
        setPhase("wait_init");
        return;
      }

      setWaitBusy(true);
      setPhase("wait_init");
      try {
        const init = await api.getTeachingClientInit(activity.id);
        if (
          isTeachingWorkspaceContentUsable(
            { generateStatus: resume.generateStatus },
            init,
          )
        ) {
          setWorkspaceInit(init);
          setPhase("workspace");
        } else {
          setWaitError("主讲内容尚未可用；请稍后再继续。断点与草稿仍保留。");
        }
      } catch (err) {
        setWaitError(
          err instanceof Error
            ? err.message
            : "无法拉取 client-init；不会伪造讲义。",
        );
      } finally {
        setWaitBusy(false);
      }
    },
    [activity, api],
  );

  // First resume read for this activity: go straight in (or to the waiting view).
  useEffect(() => {
    if (!autoOpen.current || phase !== "card" || !liveResume || liveResume.activityId !== activity.id) return;
    autoOpen.current = false;
    void openWorkspaceFromResume(liveResume);
  }, [activity.id, liveResume, openWorkspaceFromResume, phase]);

  // While the compile runs, re-read the resume until the lecture can open.
  useEffect(() => {
    if (phase !== "wait_init" || liveResume?.gates.job !== "in_flight") return;
    if (polls.current >= AUTO_OPEN_MAX_POLLS) { setPollExhausted(true); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      polls.current += 1;
      void (async () => {
        try {
          const fresh = await api.getTeachingResume(activity.id);
          if (cancelled) return;
          if (fresh.generateStatus !== activity.generateStatus || fresh.contentVersion !== activity.contentVersion) {
            const next = await api.getTeachingActivity(activity.id);
            if (cancelled) return;
            setActivity(next);
            onActivityUpdatedRef.current?.(next);
          }
          await openWorkspaceFromResume(fresh);
        } catch (err) {
          if (!cancelled) setWaitError(err instanceof Error ? err.message : "暂时无法读取备课进度，可稍后重试。");
        }
      })();
    }, AUTO_OPEN_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activity.contentVersion, activity.generateStatus, activity.id, api, liveResume, openWorkspaceFromResume, phase]);

  const backToCard = useCallback(() => {
    setPhase("card");
    setWaitError(null);
  }, []);

  // Re-read the resume so a finished job is seen; the cached one still says in_flight.
  const retryFromFreshResume = useCallback(async () => {
    polls.current = 0;
    setPollExhausted(false);
    setWaitError(null);
    setWaitBusy(true);
    try {
      const fresh = await api.getTeachingResume(activity.id);
      setWaitBusy(false);
      await openWorkspaceFromResume(fresh);
    } catch (err) {
      setWaitBusy(false);
      setWaitError(err instanceof Error ? err.message : "暂时无法读取备课进度，可稍后重试。");
    }
  }, [activity.id, api, openWorkspaceFromResume]);

  const requestCompile = useCallback(async () => {
    setWaitBusy(true);
    setWaitError(null);
    try {
      const next = await api.requestTeachingCompile(activity.id, `compile:${Date.now().toString(36)}`);
      setActivity(next);
      onActivityUpdated?.(next);
      setLiveResume(await api.getTeachingResume(activity.id));
    } catch (err) {
      setWaitError(err instanceof Error ? err.message : "无法开始生成主讲内容。");
    } finally {
      setWaitBusy(false);
    }
  }, [activity.id, api, onActivityUpdated]);

  if (activity.status === "completed" && phase !== "workspace") {
    return <div className="p-5" data-teaching-continue-entry="completed"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} {...(onNextActivity ? { onNextActivity } : {})} /></div>;
  }
  if (phase === "workspace" && workspaceInit) {
    return (
      <div data-teaching-continue-entry="workspace">
        <TeachingWorkspace
          activity={activity}
          clientInit={workspaceInit}
          assistantHref={assistantHref}
          timeZone={timeZone}
          api={api}
          onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }}
          {...(onNextActivity ? { onNextActivity } : {})}
        />
      </div>
    );
  }

  if (phase === "wait_init") {
    const canCompile = canRequestTeachingCompile(liveResume ?? activity, {
      compilerEnabled: teachingCompileEnabled,
    });
    const actions = waitInitActionVisibility({
      jobGate: liveResume?.gates.job,
      canCompile,
    });
    const waitingInFlight = liveResume?.gates.job === "in_flight" && !pollExhausted;
    return (
      <section
        className="flex h-full min-h-0 flex-col px-5 py-5"
        data-teaching-continue-entry="wait_init"
        data-resume-client-init="null"
      >
        <h2 className="text-sm font-semibold text-zinc-900">
          {waitingInFlight ? "AI 老师正在备课" : "主讲内容暂不可用"}
        </h2>
        <p className="mt-2 text-xs leading-5 text-zinc-600" role="status" data-teaching-wait-auto={waitingInFlight ? "polling" : "stopped"}>
          {waitingInFlight
            ? "正在根据你的任务和材料准备这一节，通常需要十几秒到一分钟；准备好后会自动打开，不用刷新。"
            : liveResume?.gates.job === "in_flight"
              ? "备课时间比平时长。可以稍后点「刷新备课进度」，或先去自由对话。"
              : "这一节还没有可用的主讲内容。可以重新生成，或返回学习记录卡片。"}
        </p>
        {waitError ? (
          <p className={`mt-3 text-xs ${tone.danger}`} role="alert">
            {waitError}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {actions.showCompile ? (
            <button
              type="button"
              className={ui.primary}
              disabled={waitBusy}
              data-teaching-request-compile="true"
              onClick={() => void requestCompile()}
            >
              {waitBusy ? "正在提交…" : "重新生成主讲内容"}
            </button>
          ) : null}
          {actions.showRetryFetch ? (
            <button
              type="button"
              className={ui.secondary}
              disabled={waitBusy}
              data-resume-retry-client-init="true"
              onClick={() => void retryFromFreshResume()}
            >
              {waitBusy ? "读取中…" : "刷新备课进度"}
            </button>
          ) : null}
          {actions.showBack ? (
            <button
              type="button"
              className={ui.quiet}
              data-resume-back-to-card="true"
              onClick={backToCard}
            >
              返回断点卡片
            </button>
          ) : null}
        </div>
        <div className="mt-5"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} {...(onNextActivity ? { onNextActivity } : {})} /></div>
      </section>
    );
  }

  return (
    <div data-teaching-continue-entry="card">
      <ResumeCard
        activity={activity}
        resume={liveResume}
        localUnsent={localUnsent}
        api={api}
        onContinue={(resume) => void openWorkspaceFromResume(resume)}
        onActivityUpdated={(next) => {
          setActivity(next);
          onActivityUpdated?.(next);
        }}
        onResumeUpdated={setLiveResume}
      />
      <div className="px-5 pb-5"><ActivityEndControl activity={activity} api={api} onActivityUpdated={(next) => { setActivity(next); onActivityUpdated?.(next); }} {...(onNextActivity ? { onNextActivity } : {})} /></div>
    </div>
  );
}

