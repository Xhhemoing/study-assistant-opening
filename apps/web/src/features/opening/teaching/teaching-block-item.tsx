"use client";

import type {
  TeachingCommandConflict,
  TeachingCommandSuccess,
  TeachingSourceRef,
} from "@aistudy/contracts";
import type { TeachingBlockFocusStatus } from "@aistudy/domain";
import type { OpeningApi } from "../client/api";
import { BlockRenderer } from "./block-renderer";
import { BlockCommands } from "./block-commands";
import type { ClientInitBlock } from "./component-catalog";
import type { InlineAttemptContext } from "./inline-attempt";
import type { StudyConversationContext } from "../assistant/study-conversation-context";
import { InlineExplain } from "./inline-explain";
import { teachingStudyUnitText } from "./study-unit-focus";
import { normalizeToCatalogId } from "./component-catalog";
import { useState } from "react";
import { ExplanationActions, explanationActionPrompt } from "./explanation-actions";

/** Chrome classes for focus status — keep past/skipped dimmed, current ringed. */
export function teachingBlockItemClassName(
  focusStatus: TeachingBlockFocusStatus,
): string {
  if (focusStatus === "current") {
    return "space-y-1 rounded-lg ring-2 ring-accent/55 ring-offset-2";
  }
  if (focusStatus === "past" || focusStatus === "skipped") {
    return "space-y-1 opacity-90";
  }
  return "space-y-1";
}

export type TeachingBlockItemProps = {
  block: ClientInitBlock;
  focusStatus: TeachingBlockFocusStatus;
  schemaVersion?: string | null;
  sourceRefs?: TeachingSourceRef[];
  attemptContext?: InlineAttemptContext;
  /** When false, omit BlockCommands (e.g. completed activity). */
  showCommands: boolean;
  activityId: string;
  contentVersion: number;
  pathVersion: number;
  returnDisabled: boolean;
  whyAvailable: boolean;
  api: OpeningApi;
  onSuccess: (result: TeachingCommandSuccess) => void;
  onConflict: (conflict: TeachingCommandConflict) => void;
  onReread: () => void | Promise<void>;
  /** A complete unit supplies its own hierarchy; individual blocks need no competing frame. */
  unitChrome?: boolean;
  explanationContext?: StudyConversationContext;
  onAskExplanation?: (text: string) => void;
};

/**
 * Shared teaching-block chrome: focus attrs + BlockRenderer + BlockCommands.
 * Used for both the past/skipped `<details>` list and the current/upcoming main list.
 */
export function TeachingBlockItem({
  block,
  focusStatus,
  schemaVersion,
  sourceRefs,
  attemptContext,
  showCommands,
  activityId,
  contentVersion,
  pathVersion,
  returnDisabled,
  whyAvailable,
  api,
  onSuccess,
  onConflict,
  onReread,
  unitChrome = false,
  explanationContext,
  onAskExplanation,
}: TeachingBlockItemProps) {
  const [actionsVisible, setActionsVisible] = useState(false);
  const catalog = normalizeToCatalogId(block.blockType, block.role);
  const explanation = explanationContext && ["text", "math", "step", "example"].includes(catalog)
    ? teachingStudyUnitText({ id: block.blockId, title: "", blocks: [block], questionBlockId: null }) : "";
  return (
    <div
      className={unitChrome ? "min-w-0 space-y-3" : teachingBlockItemClassName(focusStatus)}
      tabIndex={explanation ? 0 : undefined}
      role={explanation ? "group" : undefined}
      aria-label={explanation ? "调整本段讲解" : undefined}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setActionsVisible(false); }}
      onFocus={() => setActionsVisible(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsVisible(false); }}
      data-teaching-block-focus={focusStatus}
      data-block-id={block.blockId}
    >
      <BlockRenderer
        block={block}
        schemaVersion={schemaVersion}
        sourceRefs={sourceRefs}
        attemptContext={attemptContext}
      />
      {explanation && explanationContext && onAskExplanation ? <div hidden={!actionsVisible} className={actionsVisible ? "space-y-1" : "hidden"}>
        <ExplanationActions onAction={action => onAskExplanation(explanationActionPrompt(action, explanation))} />
        <InlineExplain context={{ ...explanationContext, blockId: block.blockId }} content={explanation}
          heading="保存这段讲解" initiallyCollapsed onContinueInChat={() => onAskExplanation(explanation)} />
      </div> : null}
      {showCommands ? (
        <BlockCommands
          activityId={activityId}
          blockId={block.blockId}
          contentVersion={contentVersion}
          pathVersion={pathVersion}
          returnDisabled={returnDisabled}
          whyAvailable={whyAvailable}
          api={api}
          onSuccess={onSuccess}
          onConflict={onConflict}
          onReread={onReread}
          explanationContext={explanationContext}
          onAskExplanation={onAskExplanation}
        />
      ) : null}
    </div>
  );
}
