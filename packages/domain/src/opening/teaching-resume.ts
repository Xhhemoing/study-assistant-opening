import type {
  LearningResumeAttemptSummary,
  LearningResumeOpenProblem,
  TeachingActivityGenerateStatus,
  TeachingBranchFrame,
  TeachingCommandLogEntry,
  TeachingContinuableAction,
  TeachingDraftAnchor,
  TeachingResumeJobGate,
  TeachingResumeMaterialsGate,
} from "@aistudy/contracts";
import {
  TEACHING_COMMAND_LOG_MAX,
  teachingDraftAnchorSchema,
  teachingBranchFrameSchema,
  teachingCommandLogEntrySchema,
} from "@aistudy/contracts";
import {
  TEACHING_COMMAND_CHECKPOINT_KEYS,
  readBranchStack,
  readCommandLog,
  readSkippedBlockIds,
} from "./teaching-commands";

/** Keys V2-14 may patch — must not clobber V2-11 prefs or other V2-12 command keys unless explicitly patched. */
export const TEACHING_RESUME_CHECKPOINT_KEYS = [
  "drafts",
  "currentBlockId",
  "interactionParams",
  "openProblemIds",
] as const;

export type TeachingResumeCheckpointPatch = Partial<{
  drafts: TeachingDraftAnchor[] | unknown;
  currentBlockId: string | null;
  interactionParams: Record<string, Record<string, unknown>>;
  openProblemIds: string[];
}>;

/**
 * Merge resume/checkpoint patch while preserving interventionPrefs / interventionDecisions /
 * branchStack / commandLog / skippedBlockIds / unknown keys (unless explicitly patched).
 * Same spirit as mergeCheckpointPreservingPrefs — shallow copy of prev, selective overlay.
 */
export function mergeCheckpointResumePatch(
  prev: Record<string, unknown>,
  patch: TeachingResumeCheckpointPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev };
  if ("drafts" in patch) next.drafts = patch.drafts;
  if ("currentBlockId" in patch) next.currentBlockId = patch.currentBlockId;
  if ("interactionParams" in patch) next.interactionParams = patch.interactionParams;
  if ("openProblemIds" in patch) next.openProblemIds = patch.openProblemIds;
  return next;
}

/** Assert V2-11 + V2-12 keys survive a resume patch that only touches interactionParams/drafts. */
export function resumePatchPreservesCommandAndPrefsKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  patch: TeachingResumeCheckpointPatch,
): boolean {
  if (before.interventionPrefs !== undefined) {
    if (after.interventionPrefs !== before.interventionPrefs) return false;
  }
  if (before.interventionDecisions !== undefined) {
    if (after.interventionDecisions !== before.interventionDecisions) return false;
  }
  for (const key of TEACHING_COMMAND_CHECKPOINT_KEYS) {
    if (key === "currentBlockId" && "currentBlockId" in patch) continue;
    if (before[key] !== undefined && after[key] !== before[key]) return false;
  }
  // drafts are resume-patchable; when not patched they must survive
  if (!("drafts" in patch) && before.drafts !== undefined && after.drafts !== before.drafts) {
    return false;
  }
  return true;
}

export function mapGenerateStatusToJobGate(
  generateStatus: TeachingActivityGenerateStatus | string,
): TeachingResumeJobGate {
  if (generateStatus === "queued" || generateStatus === "generating") {
    return "in_flight";
  }
  if (generateStatus === "unknown") return "unknown";
  if (generateStatus === "stale") return "stale";
  return "ready";
}

/**
 * Pure materials gate from requested vs available (admitted) source ids.
 * Fail-soft: never throws; empty requested → available.
 */
export function probeMaterialsAvailability(
  requestedIds: readonly string[],
  availableIds: readonly string[],
): {
  materials: TeachingResumeMaterialsGate;
  unavailableSourceIds: string[];
} {
  const requested = [...new Set(requestedIds)].sort();
  if (!requested.length) {
    return { materials: "available", unavailableSourceIds: [] };
  }
  const available = new Set(availableIds);
  const unavailableSourceIds = requested.filter((id) => !available.has(id));
  if (!unavailableSourceIds.length) {
    return { materials: "available", unavailableSourceIds: [] };
  }
  if (unavailableSourceIds.length === requested.length) {
    return { materials: "unavailable", unavailableSourceIds };
  }
  return { materials: "partial", unavailableSourceIds };
}

export type DeriveOpenProblemAttempt = {
  attemptId: string;
  problemId: string | null;
  itemVersionId: string | null;
  submittedAt: string | null;
  outcome?: string | null;
};

export type DeriveOpenProblemObservationHead = {
  problemId: string;
  itemVersionId: string | null;
  outcome: "correct" | "incorrect" | "unverified";
};

/**
 * Derive open problems from fact heads — do not invent a parallel store.
 * - Unsubmitted attempts with problemId → attempt_open
 * - Observation heads incorrect → incorrect_unresolved
 * - Observation heads unverified → unverified_unresolved
 * - Optional checkpoint openProblemIds → checkpoint_listed (non-authoritative mirror)
 * Correct heads close that problemId (facts win over checkpoint cache).
 */
export function deriveOpenProblems(input: {
  attempts: readonly DeriveOpenProblemAttempt[];
  observationHeads: readonly DeriveOpenProblemObservationHead[];
  checkpointOpenProblemIds?: readonly string[];
}): LearningResumeOpenProblem[] {
  const byProblem = new Map<string, LearningResumeOpenProblem>();

  for (const attempt of input.attempts) {
    if (!attempt.problemId) continue;
    if (attempt.submittedAt == null) {
      byProblem.set(attempt.problemId, {
        problemId: attempt.problemId,
        itemVersionId: attempt.itemVersionId,
        reason: "attempt_open",
      });
    }
  }

  for (const head of input.observationHeads) {
    if (head.outcome === "correct") {
      byProblem.delete(head.problemId);
      continue;
    }
    byProblem.set(head.problemId, {
      problemId: head.problemId,
      itemVersionId: head.itemVersionId,
      reason:
        head.outcome === "incorrect"
          ? "incorrect_unresolved"
          : "unverified_unresolved",
    });
  }

  for (const id of input.checkpointOpenProblemIds ?? []) {
    if (byProblem.has(id)) continue;
    // Only add checkpoint_listed when facts have not already closed it via correct head
    const closedByCorrect = input.observationHeads.some(
      (h) => h.problemId === id && h.outcome === "correct",
    );
    if (closedByCorrect) continue;
    byProblem.set(id, {
      problemId: id,
      itemVersionId: null,
      reason: "checkpoint_listed",
    });
  }

  return [...byProblem.values()].slice(0, 100);
}

export function listContinuableActions(input: {
  jobGate: TeachingResumeJobGate;
  materials: TeachingResumeMaterialsGate;
  branchStack: readonly TeachingBranchFrame[];
  drafts: readonly unknown[];
  status: string;
  hasClientInit: boolean;
}): TeachingContinuableAction[] {
  const actions: TeachingContinuableAction[] = [];

  if (input.jobGate === "in_flight" || input.jobGate === "unknown") {
    actions.push("wait_job");
  }
  if (input.materials === "unavailable" || input.materials === "partial") {
    actions.push("resolve_material");
  }
  if (input.hasClientInit && input.jobGate === "ready") {
    actions.push(
      "continue_block",
      "command_why",
      "command_rephrase",
      "command_expand",
      "command_example",
      "command_skip",
      "command_branch",
    );
  }
  if (input.branchStack.length > 0) {
    actions.push("command_return");
  }
  if (input.drafts.length > 0) {
    actions.push("edit_draft");
  }
  // paused/active both may continue; completed/skipped still return structured resume
  void input.status;
  return [...new Set(actions)];
}

/**
 * Test seam / documentation: assembleLearningResume must never call summarizeLearning
 * or tutor digest. This helper returns a skip marker for the optional summary field.
 */
export function resumeSummarySkipped(): { status: "skipped" } {
  return { status: "skipped" };
}

/** Compile-time / runtime marker for tests — resume path independence. */
export function assertResumeIndependentOfSummary(): void {
  // Intentionally empty: presence of this export + tests that assemble without
  // importing summarizeLearning prove independence. Do not call AI summarize here.
}

export function readInteractionParams(
  checkpoint: Record<string, unknown> | null | undefined,
): Record<string, Record<string, unknown>> {
  if (!checkpoint || typeof checkpoint.interactionParams !== "object") return {};
  const raw = checkpoint.interactionParams;
  if (!raw || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>;
    }
  }
  return out;
}

export function readOpenProblemIds(
  checkpoint: Record<string, unknown> | null | undefined,
): string[] {
  if (!checkpoint || !Array.isArray(checkpoint.openProblemIds)) return [];
  return checkpoint.openProblemIds.map(String).slice(0, 64);
}

export function readDraftsFromCheckpoint(
  checkpoint: Record<string, unknown> | null | undefined,
): TeachingDraftAnchor[] {
  if (!checkpoint || !Array.isArray(checkpoint.drafts)) return [];
  const out: TeachingDraftAnchor[] = [];
  for (const raw of checkpoint.drafts) {
    const parsed = teachingDraftAnchorSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, 64);
}

export function extractThoughtTrain(
  checkpoint: Record<string, unknown> | null | undefined,
): {
  currentBlockId: string | null;
  skippedBlockIds: string[];
  branchStack: TeachingBranchFrame[];
  commandLog: TeachingCommandLogEntry[];
} {
  const currentBlockId =
    checkpoint && typeof checkpoint.currentBlockId === "string"
      ? checkpoint.currentBlockId
      : checkpoint?.currentBlockId === null
        ? null
        : null;
  const branchStack = readBranchStack(checkpoint)
    .map((frame) => teachingBranchFrameSchema.safeParse(frame))
    .filter((r): r is { success: true; data: TeachingBranchFrame } => r.success)
    .map((r) => r.data);
  const commandLog = readCommandLog(checkpoint)
    .map((entry) => teachingCommandLogEntrySchema.safeParse(entry))
    .filter((r): r is { success: true; data: TeachingCommandLogEntry } => r.success)
    .map((r) => r.data)
    .slice(-TEACHING_COMMAND_LOG_MAX);
  return {
    currentBlockId,
    skippedBlockIds: readSkippedBlockIds(checkpoint),
    branchStack,
    commandLog,
  };
}

export function mapAttemptRowsToSummaries(
  rows: readonly {
    attemptId: string;
    problemId: string | null;
    itemVersionId: string | null;
    submittedAt: string | null;
    outcome: string | null;
    assistance?: string | null;
  }[],
): LearningResumeAttemptSummary[] {
  return rows.slice(0, 100).map((row) => {
    let outcome: LearningResumeAttemptSummary["outcome"] = null;
    if (row.submittedAt == null) outcome = "in_progress";
    else if (
      row.outcome === "correct" ||
      row.outcome === "incorrect" ||
      row.outcome === "unverified"
    ) {
      outcome = row.outcome;
    }
    const assistance =
      row.assistance === "independent" ||
      row.assistance === "hinted" ||
      row.assistance === "revealed" ||
      row.assistance === "unknown"
        ? row.assistance
        : undefined;
    return {
      attemptId: row.attemptId,
      problemId: row.problemId,
      itemVersionId: row.itemVersionId,
      outcome,
      ...(assistance ? { assistance } : {}),
      submittedAt: row.submittedAt,
    };
  });
}
