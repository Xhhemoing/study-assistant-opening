import type { CourseGoal, LearningActivityKind, TaskItem } from "@aistudy/contracts";
import type { EvidenceEligibilityValue } from "../evidence-eligibility";
import type { Assistance, SkillStatus } from "./types";

/** Outcome of reading one data source. "unavailable" is a failure and never means "empty". */
export type SnapshotDataStatus = "available" | "not_configured" | "unavailable";

/**
 * One effective observation head (revised and retracted rows already excluded),
 * judged by evaluateEvidenceEligibility. `verifiedCorrect: "no"` is valid negative
 * evidence; only `"unknown"` means the result could not be confirmed.
 */
export type SnapshotObservation = {
  id: string;
  skillLabel: string;
  /** Original attempt time (ISO); a revision keeps the attempt's time. */
  attemptedAt: string;
  assistance: Assistance;
  verifiedCorrect: EvidenceEligibilityValue;
  independentAttempt: EvidenceEligibilityValue;
  problemId: string | null;
};

/** One summarizeObservations row over the course's full evidence (not the HTTP projection). */
export type SnapshotSkillSummary = {
  skillLabel: string;
  status: SkillStatus;
  lastObservedAt: string | null;
};

export type SnapshotKnowledgeNode = {
  id: string;
  title: string;
  prerequisiteIds: readonly string[];
};

export type SnapshotCourseSource = {
  courseId: string;
  title: string;
  goal: CourseGoal | null;
  /** At least one course material is parsed and usable for questions. */
  hasUsableMaterials: boolean;
  /** When not "available", the course stays in the snapshot with no skills or next skills. */
  evidenceStatus: SnapshotDataStatus;
  /** May hold several rows for one skill label (one per requirement). */
  summaries: readonly SnapshotSkillSummary[];
  /** Any order. */
  observations: readonly SnapshotObservation[];
  /** In study (outline) order. */
  knowledgeNodes: readonly SnapshotKnowledgeNode[];
};

/** A stored task with the fields TaskItem does not expose. */
export type SnapshotTaskRow = {
  /** Planner suggestions use `planner:<date>:<identity>` (see suggestionKey). */
  clientKey: string | null;
  status: TaskItem["status"];
  minutes: number;
  courseId: string | null;
  /** Local YYYY-MM-DD on which the task became done or skipped; null while pending. */
  closedLocalDate: string | null;
};

/**
 * Everything the server reads for one local day, before assembly into a LearnerSnapshot.
 * Courses are the workspace's unarchived courses; scope is resolved by the caller.
 */
export type LearnerSnapshotSources = {
  /** Local YYYY-MM-DD being planned. */
  date: string;
  timeZone: string;
  courses: readonly SnapshotCourseSource[];
  tasks: readonly SnapshotTaskRow[];
  dueCardCount: number;
};

export type NextStepReasonCode =
  | "requested_full"
  | "no_evidence"
  | "unverified_only"
  | "verified_incorrect"
  | "assistance_dependent"
  | "independent"
  | "needs_check";

export type NextLearningStepInput = {
  /** Planning status of the skill from the assembled snapshot. */
  status: SkillStatus;
  /** Effective heads for this skill, newest first. */
  observations: readonly SnapshotObservation[];
  /** The learner explicitly asked for a full explanation in this activity. */
  wantsFullExplanation: boolean;
};

export type NextLearningStep = {
  activityKind: LearningActivityKind;
  /** The verified-incorrect attempt to explain against; null when there is none. */
  focusObservationId: string | null;
  reasonCode: NextStepReasonCode;
};
