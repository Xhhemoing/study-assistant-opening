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

/** Chrome classes for focus status — keep past/skipped dimmed, current ringed. */
export function teachingBlockItemClassName(
  focusStatus: TeachingBlockFocusStatus,
): string {
  if (focusStatus === "current") {
    return "space-y-1 rounded-lg ring-2 ring-emerald-500/55 ring-offset-2";
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
}: TeachingBlockItemProps) {
  return (
    <div
      className={teachingBlockItemClassName(focusStatus)}
      data-teaching-block-focus={focusStatus}
      data-block-id={block.blockId}
    >
      <BlockRenderer
        block={block}
        schemaVersion={schemaVersion}
        sourceRefs={sourceRefs}
        attemptContext={attemptContext}
      />
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
        />
      ) : null}
    </div>
  );
}
