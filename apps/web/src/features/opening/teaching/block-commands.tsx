"use client";
import { userFacingMessage } from "../../../lib/user-facing-error";

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
import { useCallback, useEffect, useRef, useState } from "react";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { ui, tone } from "../design/ui";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { InlineExplain } from "./inline-explain";

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
  confused: "这里没看懂",
  why: "为什么",
  rephrase: "换种说法",
  expand: "展开",
  example: "举例",
  skip: "跳过",
  branch: "分支",
  return: "返回",
};

const CONFLICT_LABEL: Record<TeachingCommandConflictCode, string> = {
  stale_content_version: "教学内容已更新，请重新读取后再试",
  stale_path_version: "学习路径已更新，请重新读取后再试",
  stale_revision: "教材已更新，请重新读取后再试",
  client_key_intent_mismatch: "这次操作与上次提交的内容不一致，请重新读取后再试",
  block_not_in_spec: "这部分内容已调整，请重新读取",
  branch_stack_empty: "没有可返回的分支",
  generate_in_flight: "教学内容仍在生成中，请稍后再改写",
  draft_anchor_lost: "部分笔记的关联位置已改变，请保留原文并重新读取",
  validation: "这次操作未能完成，请检查内容后重试",
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
  "可以先跳过这一步，不会记为答错。";

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
  explanationContext?: StudyConversationContext;
  onAskExplanation?: (text: string) => void;
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
  explanationContext,
  onAskExplanation,
}: BlockCommandsBarViewProps) {
  const diagnostics = useDiagnosticsEnabled();
  const busy = busyKind != null || rereadBusy;
  const visibleKinds = whyAvailable
    ? TEACHING_COMMAND_KINDS
    : TEACHING_COMMAND_KINDS.filter((kind) => kind !== "why");
  const showAssist =
    (whyAvailable || assist?.kind === "confused") &&
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
      <button type="button" className={ui.secondary} disabled={disabled || busy} onClick={() => onCommand("confused")}>
        {busyKind === "confused" ? "正在记下…" : "这里没看懂"}
      </button>
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
        <div className="mt-2 space-y-2 rounded-lg border border-line p-3">
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
          <p className="text-xs leading-5 text-text-3" data-skip-honesty="true">
            {SKIP_HONESTY_COPY}
          </p>
        </div>
      </details>

      {showAssist && assist?.kind === "why" && explanationContext && onAskExplanation ? <InlineExplain
        context={{ ...explanationContext, blockId }} content={assist!.summary!}
        onContinueInChat={() => onAskExplanation(assist!.summary!)} /> : showAssist ? (
        <div
          className={`rounded-lg px-3 py-2 text-xs leading-5 ${tone.success}`}
          role="status"
          data-command-assist={assist!.kind}
        >
          <p className="mb-0.5 font-medium">{assist!.kind === "confused" ? "已记下" : "说明"}</p>
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
            {teachingCommandConflictLabel(conflict.conflict)}
          </p>
          {diagnostics ? (
            <details className="mt-1 text-text-2">
              <summary className="min-h-11 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent py-2">
                技术信息
              </summary>
              <p className="mt-1">{conflict.message}</p>
              <p className="mt-1 tabular-nums">
                当前内容
                {conflict.currentContentVersion != null
                  ? ` content=${conflict.currentContentVersion}`
                  : ""}
                {conflict.currentPathVersion != null
                  ? ` path=${conflict.currentPathVersion}`
                  : ""}
              </p>
            </details>
          ) : null}
          <p className="mt-1 text-text-2">
            请先保留你写下的内容，重新读取后再继续。
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
              重新读取教学内容
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
  explanationContext?: StudyConversationContext;
  onAskExplanation?: (text: string) => void;
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
  explanationContext,
  onAskExplanation,
}: BlockCommandsProps) {
  const api = apiProp ?? createOpeningApi();
  const [busyKind, setBusyKind] = useState<TeachingCommandKind | null>(null);
  const [rereadBusy, setRereadBusy] = useState(false);
  const [conflict, setConflict] = useState<TeachingCommandConflict | null>(null);
  const [assist, setAssist] = useState<{ binding: string; value: TeachingCommandAssist; context?: StudyConversationContext } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const binding = JSON.stringify([activityId, blockId, contentVersion]);
  const currentBinding = useRef({ key: binding });
  if (currentBinding.current.key !== binding) currentBinding.current = { key: binding };
  const operation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setAssist(null); setConflict(null); setError(null); setBusyKind(null); setRereadBusy(false);
  }, [binding]);

  const runCommand = useCallback(
    async (kind: TeachingCommandKind) => {
      if (busyKind) return;
      if (kind === "return" && returnDisabled) return;
      if (kind === "why" && !whyAvailable) return;
      const snapshot = currentBinding.current;
      const request = ++operation.current;
      const isCurrent = () => mounted.current && currentBinding.current === snapshot && operation.current === request;
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
        if (!isCurrent()) return;
        if (result.ok) {
          setConflict(null);
          if (result.assist) setAssist({ binding: snapshot.key, value: result.assist, context: explanationContext });
          onSuccess?.(result);
        } else {
          setAssist(null);
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
        if (isCurrent()) setError(userFacingMessage(err, "命令失败"));
      } finally {
        if (isCurrent()) setBusyKind(null);
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
      explanationContext,
    ],
  );

  const handleReread = useCallback(async () => {
    if (!onReread || rereadBusy) return;
    const snapshot = currentBinding.current;
    const request = ++operation.current;
    const isCurrent = () => mounted.current && currentBinding.current === snapshot && operation.current === request;
    setRereadBusy(true);
    setError(null);
    setAssist(null);
    try {
      await onReread();
      if (isCurrent()) setConflict(null);
    } catch (err) {
      if (isCurrent()) setError(userFacingMessage(err, "重新拉取失败"));
    } finally {
      if (isCurrent()) setRereadBusy(false);
    }
  }, [onReread, rereadBusy]);

  return (
    <div>
      <BlockCommandsBarView
        blockId={blockId}
        busyKind={busyKind}
        returnDisabled={returnDisabled}
        conflict={conflict}
        assist={assist?.binding === binding ? assist.value : null}
        disabled={disabled}
        compact={compact}
        defaultOpen={defaultOpen}
        whyAvailable={whyAvailable}
        onCommand={(kind) => void runCommand(kind)}
        onReread={onReread ? () => void handleReread() : undefined}
        rereadBusy={rereadBusy}
        explanationContext={assist?.binding === binding ? assist.context : explanationContext}
        onAskExplanation={onAskExplanation}
      />
      {error ? (
        <p className={`mt-2 text-xs ${tone.danger}`} role="alert" data-command-error="true">
          {error}
        </p>
      ) : null}
    </div>
  );
}
