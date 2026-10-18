"use client";

/**
 * V2-12 Experience — block-level teaching commands.
 * Nest into TeachingWorkspace block chrome (no new shell).
 * POST /api/opening/teaching/activities/{id}/commands via OpeningApi.
 *
 * Locks: bind activityId+blockId+contentVersion+clientKey; conflict → re-read/merge
 * (forbid LWW); return disabled when branch stack empty; why = assist only;
 * skip ≠ wrong-answer honesty copy; preserve drafts (no local wipe).
 */

import {
  teachingCommandConflictCodeSchema,
  type TeachingCommandAssist,
  type TeachingCommandConflict,
  type TeachingCommandConflictCode,
  type TeachingCommandKind,
  type TeachingCommandRequest,
  type TeachingCommandResponse,
  type TeachingCommandSuccess,
} from "@aistudy/contracts";
import { ChevronDown, CircleHelp, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui, tone } from "../design/ui";

export const TEACHING_COMMAND_KINDS: TeachingCommandKind[] = [
  "why",
  "rephrase",
  "expand",
  "example",
  "skip",
  "branch",
  "return",
];

const KIND_LABEL: Record<TeachingCommandKind, string> = {
  why: "为什么",
  rephrase: "换种说法",
  expand: "展开",
  example: "举例",
  skip: "跳过",
  branch: "分支",
  return: "返回",
};

const CONFLICT_LABEL: Record<TeachingCommandConflictCode, string> = {
  stale_content_version: "内容版本已过期，请重新拉取后再试",
  stale_path_version: "路径版本已过期，请重新拉取后再试",
  stale_revision: "教材修订号已过期，请重新拉取后再试",
  client_key_intent_mismatch: "同一操作密钥意图不一致，请换一把新密钥重试",
  block_not_in_spec: "该块已不在当前教学内容中，请重新拉取",
  branch_stack_empty: "没有可返回的分支",
  generate_in_flight: "教学内容仍在生成中，请稍后再改写",
  draft_anchor_lost: "部分草稿锚点已失效，请确认后重新拉取",
  validation: "命令参数无效",
};

/** Read branch stack depth from checkpoint_json (client-side; no domain import). */
export function branchStackDepth(
  checkpoint: Record<string, unknown> | null | undefined,
): number {
  if (!checkpoint || !Array.isArray(checkpoint.branchStack)) return 0;
  return checkpoint.branchStack.length;
}

export function isBranchStackEmpty(
  checkpoint: Record<string, unknown> | null | undefined,
): boolean {
  return branchStackDepth(checkpoint) === 0;
}

export function teachingCommandKindLabel(kind: TeachingCommandKind): string {
  return KIND_LABEL[kind];
}

export function teachingCommandConflictLabel(
  code: TeachingCommandConflictCode,
): string {
  return CONFLICT_LABEL[code] ?? code;
}

/** Conflicts that require re-read / merge — never silent overwrite. */
export function conflictRequiresReread(code: TeachingCommandConflictCode): boolean {
  return (
    code === "stale_content_version" ||
    code === "stale_path_version" ||
    code === "stale_revision" ||
    code === "block_not_in_spec" ||
    code === "draft_anchor_lost" ||
    code === "generate_in_flight" ||
    code === "client_key_intent_mismatch"
  );
}

/** Honesty: skip is path-only, not a wrong-answer / incorrect observation. */
export const SKIP_HONESTY_COPY =
  "跳过只调整学习路径，不会记为答错，也不会写入错误观察。";

export function newTeachingCommandClientKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `cmd-${crypto.randomUUID()}`;
  }
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type BlockCommandsBarViewProps = {
  blockId: string;
  busyKind?: TeachingCommandKind | null;
  returnDisabled: boolean;
  conflict?: TeachingCommandConflict | null;
  assist?: TeachingCommandAssist | null;
  disabled?: boolean;
  /** Remove outer spacing when nested in the current unit's controls. */
  compact?: boolean;
  /** Open initially when the parent already provides an explicit help panel. */
  defaultOpen?: boolean;
  /** When false, hide Why (stub-only era). Default false. */
  whyAvailable?: boolean;
  onCommand: (kind: TeachingCommandKind) => void;
  onReread?: () => void;
  rereadBusy?: boolean;
};

/**
 * Presentational block toolbar — SSR-safe for vitest static markup.
 * No force-overwrite affordance by design.
 */
export function BlockCommandsBarView({
  blockId,
  busyKind = null,
  returnDisabled,
  conflict = null,
  assist = null,
  disabled = false,
  compact = false,
  defaultOpen = false,
  whyAvailable = false,
  onCommand,
  onReread,
  rereadBusy = false,
}: BlockCommandsBarViewProps) {
  const busy = busyKind != null || rereadBusy;
  const visibleKinds = whyAvailable
    ? TEACHING_COMMAND_KINDS
    : TEACHING_COMMAND_KINDS.filter((kind) => kind !== "why");
  const showAssist =
    whyAvailable &&
    Boolean(assist?.summary) &&
    !/Why this block/i.test(assist?.summary ?? "") &&
    !(assist?.summary?.includes(blockId) ?? false);
  return (
    <div
      className={compact ? "space-y-2" : "mt-2 space-y-2"}
      data-block-commands="true"
      data-block-id={blockId}
      data-why-available={whyAvailable ? "true" : "false"}
    >
      <details className="group/help" data-command-help="true" open={defaultOpen}>
        <summary
          className={`${ui.quiet} list-none [&::-webkit-details-marker]:hidden`}
          aria-busy={busy}
        >
          {busy ? (
            <LoaderCircle size={14} className="animate-spin" aria-hidden />
          ) : (
            <CircleHelp size={14} aria-hidden />
          )}
          学习帮助
          <ChevronDown
            size={12}
            className="transition-transform group-open/help:rotate-180 motion-reduce:transition-none"
            aria-hidden
          />
        </summary>
        <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 p-3">
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="当前学习单元帮助"
          >
            {visibleKinds.map((kind) => {
              const isReturn = kind === "return";
              const kindDisabled =
                disabled || busy || (isReturn && returnDisabled);
              const title =
                kind === "skip"
                  ? SKIP_HONESTY_COPY
                  : kind === "why"
                    ? "仅解释说明，不改写正文"
                    : isReturn && returnDisabled
                      ? "分支栈为空，无法返回"
                      : KIND_LABEL[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  className={ui.secondary}
                  data-command-kind={kind}
                  disabled={kindDisabled}
                  title={title}
                  aria-label={KIND_LABEL[kind]}
                  aria-busy={busyKind === kind}
                  onClick={() => onCommand(kind)}
                >
                  {busyKind === kind ? (
                    <LoaderCircle size={12} className="animate-spin" aria-hidden />
                  ) : null}
                  {KIND_LABEL[kind]}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-5 text-zinc-500" data-skip-honesty="true">
            {SKIP_HONESTY_COPY}
          </p>
        </div>
      </details>

      {showAssist ? (
        <div
          className={`rounded-lg px-3 py-2 text-xs leading-5 ${tone.success}`}
          role="status"
          data-command-assist="why"
        >
          <p className="mb-0.5 font-medium">说明（不改写正文）</p>
          <p className="whitespace-pre-wrap">{assist!.summary}</p>
        </div>
      ) : null}

      {conflict ? (
        <div
          className={`rounded-lg px-3 py-2 text-xs leading-5 ${tone.warning}`}
          role="alert"
          data-command-conflict={conflict.conflict}
        >
          <p className="font-medium">
            命令冲突：{teachingCommandConflictLabel(conflict.conflict)}
          </p>
          <p className="mt-1 text-zinc-700">{conflict.message}</p>
          {conflict.currentContentVersion != null ||
          conflict.currentPathVersion != null ? (
            <details className="mt-1 text-zinc-600">
              <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50">
                技术信息
              </summary>
              <p className="mt-1 tabular-nums">
                服务端版本
                {conflict.currentContentVersion != null
                  ? ` content=${conflict.currentContentVersion}`
                  : ""}
                {conflict.currentPathVersion != null
                  ? ` path=${conflict.currentPathVersion}`
                  : ""}
              </p>
            </details>
          ) : null}
          <p className="mt-1 text-zinc-600">
            请重新拉取教学内容并合并本地草稿后再试；不会提供「强制覆盖」。
          </p>
          {onReread && conflictRequiresReread(conflict.conflict) ? (
            <button
              type="button"
              className={`${ui.secondary} mt-2`}
              data-command-reread="true"
              disabled={rereadBusy}
              onClick={onReread}
            >
              {rereadBusy ? (
                <LoaderCircle size={12} className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw size={12} aria-hidden />
              )}
              重新拉取教学内容
            </button>
          ) : null}
          {/* Explicit: no force-overwrite control */}
        </div>
      ) : null}
    </div>
  );
}

export type BlockCommandsProps = {
  activityId: string;
  blockId: string;
  contentVersion: number;
  pathVersion?: number;
  returnDisabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  defaultOpen?: boolean;
  /** When false, hide Why control (default). */
  whyAvailable?: boolean;
  api?: OpeningApi;
  onSuccess?: (result: TeachingCommandSuccess) => void;
  onConflict?: (conflict: TeachingCommandConflict) => void;
  onReread?: () => void | Promise<void>;
};

/**
 * Interactive block commands — posts CAS envelope; surfaces conflict for re-read.
 */
export function BlockCommands({
  activityId,
  blockId,
  contentVersion,
  pathVersion,
  returnDisabled,
  disabled = false,
  compact = false,
  defaultOpen = false,
  whyAvailable = false,
  api: apiProp,
  onSuccess,
  onConflict,
  onReread,
}: BlockCommandsProps) {
  const api = apiProp ?? createOpeningApi();
  const [busyKind, setBusyKind] = useState<TeachingCommandKind | null>(null);
  const [rereadBusy, setRereadBusy] = useState(false);
  const [conflict, setConflict] = useState<TeachingCommandConflict | null>(null);
  const [assist, setAssist] = useState<TeachingCommandAssist | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(
    async (kind: TeachingCommandKind) => {
      if (busyKind) return;
      if (kind === "return" && returnDisabled) return;
      if (kind === "why" && !whyAvailable) return;
      setBusyKind(kind);
      setError(null);
      setConflict(null);
      if (kind !== "why") setAssist(null);

      const body: TeachingCommandRequest = {
        clientKey: newTeachingCommandClientKey(),
        kind,
        expectedVersion: contentVersion,
        ...(kind === "return" ? {} : { blockId }),
        ...(pathVersion != null ? { expectedPathVersion: pathVersion } : {}),
      };

      try {
        const result: TeachingCommandResponse = await api.postTeachingCommand(
          activityId,
          body,
        );
        if (result.ok) {
          setConflict(null);
          if (result.assist) setAssist(result.assist);
          onSuccess?.(result);
        } else {
          // Discriminated conflict — never treat as success / never LWW retry.
          const parsed = teachingCommandConflictCodeSchema.safeParse(
            result.conflict,
          );
          if (!parsed.success) {
            setError("未知冲突码");
          } else {
            setConflict(result);
            onConflict?.(result);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "命令失败");
      } finally {
        setBusyKind(null);
      }
    },
    [
      activityId,
      api,
      blockId,
      busyKind,
      contentVersion,
      onConflict,
      onSuccess,
      pathVersion,
      returnDisabled,
      whyAvailable,
    ],
  );

  const handleReread = useCallback(async () => {
    if (!onReread || rereadBusy) return;
    setRereadBusy(true);
    setError(null);
    try {
      await onReread();
      setConflict(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新拉取失败");
    } finally {
      setRereadBusy(false);
    }
  }, [onReread, rereadBusy]);

  return (
    <div>
      <BlockCommandsBarView
        blockId={blockId}
        busyKind={busyKind}
        returnDisabled={returnDisabled}
        conflict={conflict}
        assist={assist}
        disabled={disabled}
        compact={compact}
        defaultOpen={defaultOpen}
        whyAvailable={whyAvailable}
        onCommand={(kind) => void runCommand(kind)}
        onReread={onReread ? () => void handleReread() : undefined}
        rereadBusy={rereadBusy}
      />
      {error ? (
        <p className={`mt-2 text-xs ${tone.danger}`} role="alert" data-command-error="true">
          {error}
        </p>
      ) : null}
    </div>
  );
}
