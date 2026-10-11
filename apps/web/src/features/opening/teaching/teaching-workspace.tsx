"use client";

import Link from "next/link";
import { ChevronDown, BookOpen } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ActivitySpecClientInit, TeachingActivity } from "@aistudy/contracts";
import { ui, tone } from "../design/ui";
import { BlockRenderer } from "./block-renderer";
import {
  isKnownSchemaVersion,
  readSchemaVersion,
} from "./component-catalog";
import {
  formatActivityUpdatedAt,
  teachingActivityGenerateStatusLabel,
  teachingActivityStatusLabel,
} from "./today-activity";
import { PreferenceControls } from "./preference-controls";

export type TeachingWorkspaceProps = {
  activity: TeachingActivity;
  clientInit: ActivitySpecClientInit;
  assistantHref?: string | null;
  timeZone?: string;
};

/** Usable gate (PM frozen): only when generateStatus === "ready". */
export function isTeachingWorkspaceContentUsable(
  activity: Pick<TeachingActivity, "generateStatus">,
  clientInit: ActivitySpecClientInit | null | undefined,
): boolean {
  if (activity.generateStatus !== "ready") return false;
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
  clientInit,
  assistantHref,
  timeZone = "Asia/Shanghai",
}: TeachingWorkspaceProps) {
  const schemaVersion = useMemo(() => readSchemaVersion(clientInit), [clientInit]);
  const schemaOk = isKnownSchemaVersion(schemaVersion);
  const orderedBlocks = useMemo(
    () => [...clientInit.blocks].sort((a, b) => a.position - b.position),
    [clientInit.blocks],
  );
  const generateTone =
    activity.generateStatus === "failed" || activity.generateStatus === "stale"
      ? tone.danger
      : activity.generateStatus === "ready"
        ? tone.success
        : tone.neutral;

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-5"
      aria-labelledby="teaching-workspace-heading"
      data-teaching-workspace="true"
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
            {teachingActivityStatusLabel(activity.status)}
          </span>
          <span className={`${ui.badge} ${generateTone}`}>
            {teachingActivityGenerateStatusLabel(activity.generateStatus)}
          </span>
        </div>
      </header>

      <p className="mt-2 text-[11px] tabular-nums text-zinc-500">
        最近更新 {formatActivityUpdatedAt(activity.updatedAt, timeZone)}
        {clientInit.verificationStatus
          ? ` · 校验 ${clientInit.verificationStatus}`
          : null}
      </p>

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
            <BlockRenderer
              key={block.blockId}
              block={block}
              schemaVersion={schemaVersion}
              sourceRefs={clientInit.sourceRefs}
            />
          ))}
        </div>
      ) : null}

      <div className="mt-6 space-y-1">
        <ExpandSection id="outline" title="提纲（按需展开）">
          {clientInit.goals.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-zinc-700">
              {clientInit.goals.map((g) => (
                <li key={g.goalId}>{g.statement}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-zinc-500">暂无提纲目标元数据。</p>
          )}
        </ExpandSection>

        <ExpandSection id="materials" title="原材料 / 引用（按需展开）">
          {clientInit.sourceRefs.length ? (
            <ul className="space-y-1.5 text-xs leading-5 text-zinc-700">
              {clientInit.sourceRefs.map((ref, i) => (
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
            草稿锚点保存在服务端 checkpoint；隐藏答案不会预加载到本页。
            {clientInit.checkpointJson && Object.keys(clientInit.checkpointJson).length
              ? ` 已有 checkpoint 字段 ${Object.keys(clientInit.checkpointJson).length} 个。`
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
    </section>
  );
}
