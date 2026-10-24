"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { TeachingActivity } from "@aistudy/contracts";
import { ui, tone } from "../design/ui";
import { TeachingGoalGuidance } from "./goal-guidance";
import {
  formatActivityUpdatedAt,
  teachingActivityContentHonesty,
  teachingActivityGenerateStatusLabel,
  teachingActivityStatusLabel,
} from "./today-activity";

export function TeachingActivityPanel({
  activity,
  assistantHref,
  timeZone = "Asia/Shanghai",
}: {
  activity: TeachingActivity;
  /** Quiet secondary link to free assistant conversation. */
  assistantHref?: string | null;
  timeZone?: string;
}) {
  const generateTone =
    activity.generateStatus === "failed" || activity.generateStatus === "stale"
      ? tone.danger
      : activity.generateStatus === "ready"
        ? tone.success
        : activity.generateStatus === "queued" || activity.generateStatus === "generating"
          ? tone.warning
          : tone.neutral;

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-5"
      aria-labelledby="today-activity-heading"
      data-today-activity-panel="true"
    >
      <h2 id="today-activity-heading" className="text-sm font-semibold text-text">
        当前教学活动
      </h2>
      <p className="mt-2 break-words text-sm leading-6 text-text-2">{activity.intentSummary}</p>
      <TeachingGoalGuidance focus={activity.learnerFocus} />
      <dl className="mt-4 grid gap-2 text-xs leading-5 text-text-2 sm:grid-cols-2">
        <div>
          <dt className="text-text-3">状态</dt>
          <dd className="mt-1">
            <span className={`${ui.badge} ${tone.neutral}`}>{teachingActivityStatusLabel(activity.status)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-text-3">生成</dt>
          <dd className="mt-1">
            <span className={`${ui.badge} ${generateTone}`}>
              {teachingActivityGenerateStatusLabel(activity.generateStatus, { contentVersion: activity.contentVersion })}
            </span>
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-text-3">最近更新</dt>
          <dd className="mt-1 tabular-nums text-text-2">
            {formatActivityUpdatedAt(activity.updatedAt, timeZone)}
          </dd>
        </div>
      </dl>
      <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-5 text-text-2 ring-1 ring-line">
        {teachingActivityContentHonesty(activity.generateStatus)}
      </p>
      {assistantHref ? (
        <p className="mt-4">
          <Link href={assistantHref} className={ui.quiet}>
            打开自由对话（次要）
          </Link>
        </p>
      ) : (
        <p className="mt-4">
          <Link href="/opening/assistant" className={ui.quiet}>
            打开自由对话（次要）
          </Link>
        </p>
      )}
    </section>
  );
}

export function TeachingActivityEmpty({
  onStart,
  busy,
  error,
  assistantHref,
}: {
  onStart: () => void;
  busy?: boolean;
  error?: string | null;
  assistantHref?: string | null;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center px-5 py-10 text-center" data-today-activity-empty="true">
      <h2 className="text-xl font-semibold tracking-tight text-text">今天，开始一点新的理解</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-text-3">
        选一项任务开始，或从一个想弄懂的问题出发。AI 主讲需要先配置模型并开启教学功能。
      </p>
      <button type="button" data-today-primary-cta="true" className={`${ui.primary} mt-5`} onClick={onStart} disabled={busy}>
        {busy ? "正在创建…" : "开始学习"}
      </button>
      {error ? <p className="mt-3 text-xs text-danger" role="alert">{error}</p> : null}
      <p className="mt-4">
        <Link href={assistantHref ?? "/opening/assistant"} className={ui.quiet}>
          先聊一个问题
        </Link>
      </p>
    </section>
  );
}
