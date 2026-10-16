function newId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? value : (value & 3) | 8;
    return nibble.toString(16);
  });
}

import type {
  TeachingBranchFrame,
  TeachingCommandKind,
  TeachingCommandLogEntry,
  TeachingCommandRequest,
  TeachingRewriteKind,
} from "@aistudy/contracts";
import {
  TEACHING_BRANCH_STACK_MAX,
  TEACHING_COMMAND_LOG_MAX,
  isTeachingRewriteKind,
} from "@aistudy/contracts";

/** Checkpoint keys owned by V2-12 — must not clobber V2-11 prefs/decisions or drafts. */
export const TEACHING_COMMAND_CHECKPOINT_KEYS = [
  "branchStack",
  "commandLog",
  "currentBlockId",
  "skippedBlockIds",
] as const;

export type TeachingCommandCheckpointPatch = Partial<{
  branchStack: TeachingBranchFrame[];
  commandLog: TeachingCommandLogEntry[];
  currentBlockId: string | null;
  skippedBlockIds: string[];
  drafts: unknown;
}>;

/**
 * Merge V2-12 path keys while preserving interventionPrefs / interventionDecisions /
 * drafts / unknown keys (same spirit as mergeSessionInterventionPrefs).
 */
export function mergeCheckpointPreservingPrefs(
  prev: Record<string, unknown>,
  patch: TeachingCommandCheckpointPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev };
  if ("branchStack" in patch) next.branchStack = patch.branchStack;
  if ("commandLog" in patch) next.commandLog = patch.commandLog;
  if ("currentBlockId" in patch) next.currentBlockId = patch.currentBlockId;
  if ("skippedBlockIds" in patch) next.skippedBlockIds = patch.skippedBlockIds;
  if ("drafts" in patch) next.drafts = patch.drafts;
  return next;
}

export function readBranchStack(
  checkpoint: Record<string, unknown> | null | undefined,
): TeachingBranchFrame[] {
  if (!checkpoint || !Array.isArray(checkpoint.branchStack)) return [];
  return checkpoint.branchStack as TeachingBranchFrame[];
}

export function readCommandLog(
  checkpoint: Record<string, unknown> | null | undefined,
): TeachingCommandLogEntry[] {
  if (!checkpoint || !Array.isArray(checkpoint.commandLog)) return [];
  return checkpoint.commandLog as TeachingCommandLogEntry[];
}

export function readSkippedBlockIds(
  checkpoint: Record<string, unknown> | null | undefined,
): string[] {
  if (!checkpoint || !Array.isArray(checkpoint.skippedBlockIds)) return [];
  return checkpoint.skippedBlockIds.map(String);
}

export function pushBranch(
  stack: readonly TeachingBranchFrame[],
  frame: TeachingBranchFrame,
  max = TEACHING_BRANCH_STACK_MAX,
): TeachingBranchFrame[] {
  const next = [...stack, frame];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

export function popBranch(
  stack: readonly TeachingBranchFrame[],
): { frame: TeachingBranchFrame; nextStack: TeachingBranchFrame[] } | { empty: true } {
  if (!stack.length) return { empty: true };
  const nextStack = stack.slice(0, -1);
  const frame = stack[stack.length - 1]!;
  return { frame, nextStack };
}

/** Locked: skip must never write graded observations / incorrect attempts. */
export function classifySkipSideEffects(): { writesObservation: false } {
  return { writesObservation: false };
}

export type AssertCommandAllowedActivity = {
  generateStatus: string;
  contentVersion: number;
  pathVersion: number;
};

export type AssertCommandAllowedResult =
  | { ok: true }
  | {
      ok: false;
      conflict:
        | "generate_in_flight"
        | "block_not_in_spec"
        | "branch_stack_empty"
        | "validation";
      message: string;
    };

/**
 * Pre-CAS domain gates (generate_in_flight for rewrite; block presence; return stack).
 * Does not authorize/deny via intervention prefs — commands are explicit user actions.
 */
export function assertCommandAllowed(input: {
  activity: AssertCommandAllowedActivity;
  kind: TeachingCommandKind;
  blockId: string | undefined;
  blockIdsInSpec: ReadonlySet<string> | readonly string[];
  branchStack: readonly TeachingBranchFrame[];
}): AssertCommandAllowedResult {
  const { activity, kind, blockId, branchStack } = input;
  const present =
    input.blockIdsInSpec instanceof Set
      ? input.blockIdsInSpec
      : new Set(input.blockIdsInSpec);

  if (isTeachingRewriteKind(kind)) {
    if (activity.generateStatus === "queued" || activity.generateStatus === "generating") {
      return {
        ok: false,
        conflict: "generate_in_flight",
        message: "rewrite blocked while teaching content is generating",
      };
    }
  }

  if (kind === "return") {
    if (!branchStack.length) {
      return {
        ok: false,
        conflict: "branch_stack_empty",
        message: "no branch frame to return to",
      };
    }
    return { ok: true };
  }

  if (!blockId) {
    return { ok: false, conflict: "validation", message: "blockId is required" };
  }
  if (!present.has(blockId)) {
    return {
      ok: false,
      conflict: "block_not_in_spec",
      message: "blockId is not in current ActivitySpec blockOrder",
    };
  }
  if (kind === "branch" || kind === "skip") {
    // targetBlockId presence checked by caller when provided
  }
  return { ok: true };
}

/** Stable fingerprint of command intent for soft-idempotent clientKey replay. */
export function fingerprintCommandIntent(
  request: Pick<
    TeachingCommandRequest,
    | "kind"
    | "blockId"
    | "expectedVersion"
    | "expectedPathVersion"
    | "prompt"
    | "branchLabel"
    | "targetBlockId"
  >,
): string {
  return JSON.stringify({
    kind: request.kind,
    blockId: request.blockId ?? null,
    expectedVersion: request.expectedVersion,
    expectedPathVersion: request.expectedPathVersion ?? null,
    prompt: request.prompt ?? null,
    branchLabel: request.branchLabel ?? null,
    targetBlockId: request.targetBlockId ?? null,
  });
}

export type CommandLogReplayLookup =
  | { hit: "replay"; entry: TeachingCommandLogEntry }
  | { hit: "mismatch"; entry: TeachingCommandLogEntry }
  | { hit: "none" };

export function findCommandLogByClientKey(
  log: readonly TeachingCommandLogEntry[],
  clientKey: string,
  intentFingerprint: string,
): CommandLogReplayLookup {
  // Ring may have evicted older entries — miss is acceptable M1 soft-idempotent edge.
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i]!;
    if (entry.clientKey !== clientKey) continue;
    if (entry.result !== "ok") continue;
    if (entry.intentFingerprint == null || entry.intentFingerprint === intentFingerprint) {
      return { hit: "replay", entry };
    }
    return { hit: "mismatch", entry };
  }
  return { hit: "none" };
}

export function appendCommandLog(
  log: readonly TeachingCommandLogEntry[],
  entry: TeachingCommandLogEntry,
  max = TEACHING_COMMAND_LOG_MAX,
): TeachingCommandLogEntry[] {
  return [...log, entry].slice(-Math.max(1, max));
}

export function nextBlockIdAfter(
  blockOrder: readonly { blockId: string }[],
  currentBlockId: string,
  targetBlockId?: string,
): string | null {
  if (targetBlockId) return targetBlockId;
  const idx = blockOrder.findIndex((b) => b.blockId === currentBlockId);
  if (idx < 0) return null;
  const next = blockOrder[idx + 1];
  return next ? next.blockId : null;
}

export type LibraryBlockLike = {
  id: string;
  type: string;
  content: Record<string, unknown>;
};

/**
 * M1 structured rewrite: clone prior blocks; annotate target block with rewrite metadata
 * + optional prompt note. Never mutates the input array/objects in place.
 */
export function buildStructuredRewriteBlocks(
  priorBlocks: readonly LibraryBlockLike[],
  input: {
    kind: TeachingRewriteKind;
    blockId: string;
    prompt?: string;
  },
): LibraryBlockLike[] {
  return priorBlocks.map((block) => {
    if (block.id !== input.blockId) {
      return {
        id: block.id,
        type: block.type,
        content: { ...block.content },
      };
    }
    const noteParts = [
      `rewrite:${input.kind}`,
      input.prompt?.trim() ? `prompt:${input.prompt.trim().slice(0, 500)}` : null,
    ].filter(Boolean);
    return {
      id: block.id,
      type: block.type,
      content: {
        ...block.content,
        rewriteOf: {
          kind: input.kind,
          note: noteParts.join(" | "),
          at: new Date().toISOString(),
        },
      },
    };
  });
}

/**
 * M1 why is not model-backed. Do not fabricate English/UUID "explanations".
 * UI should hide the Why control while this remains stub-only (`WHY_ASSIST_AVAILABLE`).
 * If the command is still invoked, return honest Chinese copy without a block UUID.
 */
export const WHY_ASSIST_AVAILABLE = false;

export const WHY_ASSIST_UNAVAILABLE_SUMMARY =
  "暂无基于学习目标与授权材料的自动解释，不会编造说明。";

/** Assist-only why projection (no body mutate). Stub-era: honest Chinese, no UUID. */
export function buildWhyAssist(_input: {
  blockId: string;
  prompt?: string;
  blockType?: string;
}): { kind: "why"; summary: string } {
  return {
    kind: "why",
    summary: WHY_ASSIST_UNAVAILABLE_SUMMARY,
  };
}

export type TeachingBlockFocusStatus = "current" | "past" | "upcoming" | "skipped";

export type TeachingBlockFocus = {
  currentBlockId: string | null;
  skippedBlockIds: readonly string[];
  /** Status for every blockId in blockOrder. */
  statusById: ReadonlyMap<string, TeachingBlockFocusStatus>;
};

/**
 * Resolve which block the learner should focus on from checkpoint cursor + skips.
 * Missing/invalid currentBlockId → first non-skipped block (else first block).
 */
export function resolveTeachingBlockFocus(
  blockOrder: readonly { blockId: string }[],
  checkpoint: Record<string, unknown> | null | undefined,
): TeachingBlockFocus {
  const skippedBlockIds = readSkippedBlockIds(checkpoint);
  const skipped = new Set(skippedBlockIds);
  const ids = blockOrder.map((b) => b.blockId);
  const raw =
    checkpoint && typeof checkpoint.currentBlockId === "string"
      ? checkpoint.currentBlockId
      : null;
  let currentBlockId: string | null = null;
  if (raw && ids.includes(raw) && !skipped.has(raw)) {
    currentBlockId = raw;
  } else {
    currentBlockId = ids.find((id) => !skipped.has(id)) ?? ids[0] ?? null;
  }

  const currentIdx = currentBlockId ? ids.indexOf(currentBlockId) : -1;
  const statusById = new Map<string, TeachingBlockFocusStatus>();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    if (skipped.has(id)) {
      statusById.set(id, "skipped");
      continue;
    }
    if (id === currentBlockId) {
      statusById.set(id, "current");
      continue;
    }
    if (currentIdx >= 0 && i < currentIdx) {
      statusById.set(id, "past");
      continue;
    }
    statusById.set(id, "upcoming");
  }

  return { currentBlockId, skippedBlockIds, statusById };
}

export function createBranchFrame(input: {
  fromBlockId: string;
  resumeBlockId?: string;
  contentVersion: number;
  pathVersion: number;
  label?: string;
  createdAt?: string;
}): TeachingBranchFrame {
  return {
    frameId: newId(),
    fromBlockId: input.fromBlockId,
    resumeBlockId: input.resumeBlockId,
    contentVersion: input.contentVersion,
    pathVersion: input.pathVersion,
    label: input.label,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function draftsSurvivingBlockIds(
  drafts: unknown,
  presentBlockIds: ReadonlySet<string>,
): { kept: unknown[]; lostBlockIds: string[] } {
  if (!Array.isArray(drafts)) return { kept: [], lostBlockIds: [] };
  const kept: unknown[] = [];
  const lostBlockIds: string[] = [];
  for (const raw of drafts) {
    if (!raw || typeof raw !== "object") continue;
    const blockId = String((raw as { blockId?: unknown }).blockId ?? "");
    if (!blockId) continue;
    if (presentBlockIds.has(blockId)) kept.push(raw);
    else lostBlockIds.push(blockId);
  }
  return { kept, lostBlockIds: [...new Set(lostBlockIds)] };
}
