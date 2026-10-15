import { createHash } from "node:crypto";
import {
  knowledgeSnapshotSchema,
  type OpeningAdaptivePrefsResponse,
  type PlanningAutonomy,
  type Scope,
} from "@aistudy/contracts";
import {
  evaluateEvidenceEligibility,
  localDateKeyInZone,
  summarizeObservations,
  type CourseEvidence,
  type LearnerSnapshot,
  type LearnerSnapshotSources,
  type SnapshotCourseSource,
  type SnapshotDataStatus,
  type SnapshotKnowledgeNode,
  type SnapshotObservation,
  type SnapshotSkillSummary,
  type SnapshotTaskRow,
} from "@aistudy/domain";
import type { LearnerSnapshotBaseRows, LearnerSnapshotTaskRow } from "@aistudy/database";

export type LearnerSnapshotReadSource = "evidence" | "goals" | "due_cards";

export type LearnerSnapshotDeps = {
  /** Unarchived courses, materials and knowledge, plus every task of the owner. */
  readBase(scope: Scope): Promise<LearnerSnapshotBaseRows>;
  /** Effective heads of one course (retracted and privacy-excluded rows removed). */
  readCourseEvidence(scope: Scope, courseId: string): Promise<CourseEvidence>;
  readAdaptivePrefs(scope: Scope): Promise<OpeningAdaptivePrefsResponse>;
  countDueCards(scope: Scope, input: { now: Date; timeZone: string }): Promise<number>;
  /** assembleLearnerSnapshot from @aistudy/domain (G5). */
  assembleSnapshot(sources: LearnerSnapshotSources): LearnerSnapshot;
  /** A degraded read is reported here; the snapshot still marks it unavailable. */
  onReadFailure?(source: LearnerSnapshotReadSource, error: unknown, courseId?: string): void;
  now?: () => Date;
};

export type LearnerSnapshotDataStatus = {
  /** "unavailable" when any course's evidence could not be read. */
  evidence: SnapshotDataStatus;
  goals: SnapshotDataStatus;
  dueCards: SnapshotDataStatus;
};

export type LearnerSnapshotRead = {
  snapshot: LearnerSnapshot;
  /** Kept for callers that need per-observation detail (teaching focus). */
  sources: LearnerSnapshotSources;
  dataStatus: LearnerSnapshotDataStatus;
  /** Unreadable preferences fail closed to "manual" so a manual learner never gets suggestions. */
  autonomy: PlanningAutonomy;
  /** Changes whenever anything the planning rules read changes. */
  plannerInputRevision: string;
  metrics: { reads: number; durationMs: number };
};

/** Chapters are outline containers, not skills; prerequisites on them are dropped. */
export function toSnapshotKnowledgeNodes(stored: unknown): SnapshotKnowledgeNode[] {
  if (stored == null) return [];
  const parsed = knowledgeSnapshotSchema.safeParse(stored);
  if (!parsed.success) return [];
  const nodes = parsed.data.nodes.filter((node) => node.kind !== "chapter");
  const ids = new Set(nodes.map((node) => node.id));
  return nodes.map((node) => ({
    id: node.id,
    title: node.label,
    prerequisiteIds: parsed.data.edges
      .filter((edge) => edge.kind === "prerequisite" && edge.to === node.id && ids.has(edge.from))
      .map((edge) => edge.from),
  }));
}

/** Full-evidence summaries and per-observation eligibility, matching the learning summary rules. */
export function toSnapshotEvidence(
  evidence: CourseEvidence,
  now: Date,
): { summaries: SnapshotSkillSummary[]; observations: SnapshotObservation[] } {
  const summaries = summarizeObservations(evidence.observations, now.toISOString(), {
    evidenceContexts: evidence.evidenceContexts,
  }).map((row) => ({ skillLabel: row.skillLabel, status: row.status, lastObservedAt: row.lastObservedAt }));
  const observations = evidence.observations.map((row): SnapshotObservation => {
    const input = evidence.evidenceContexts[row.id];
    const eligibility = evaluateEvidenceEligibility(
      input?.observation ?? {
        courseId: row.courseId,
        problemId: row.problemId,
        assistance: row.assistance,
        outcome: row.outcome,
        verdictSource: row.verdictSource,
      },
      input?.context ?? {},
    );
    // A revision keeps the original attempt time, as in summarizeObservations.
    const attemptedAt = input?.observation.submittedAt ?? Date.parse(row.submittedAt ?? row.occurredAt);
    return {
      id: row.id,
      skillLabel: row.skillLabel,
      attemptedAt: new Date(attemptedAt).toISOString(),
      assistance: row.assistance,
      verifiedCorrect: eligibility.verifiedCorrect,
      independentAttempt: eligibility.independentAttempt,
      problemId: row.problemId ?? null,
    };
  });
  return { summaries, observations };
}

export function toSnapshotTaskRow(row: LearnerSnapshotTaskRow, timeZone: string): SnapshotTaskRow {
  return {
    clientKey: row.clientKey,
    status: row.status,
    minutes: row.minutes,
    courseId: row.courseId,
    // No closed_at column: a closed task's last update is the close (reopen sets it pending).
    closedLocalDate: row.status === "pending" ? null : localDateKeyInZone(new Date(row.updatedAt), timeZone),
  };
}

function goalsStatus(prefs: OpeningAdaptivePrefsResponse): SnapshotDataStatus {
  if (prefs.invalidStoredPrefs) return "unavailable";
  return prefs.saved ? "available" : "not_configured";
}

export function learnerSnapshotRevision(sources: LearnerSnapshotSources): string {
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex").slice(0, 32);
}

/**
 * Reads everything the adaptive planner needs for one local day, outside any plan lock.
 * Missing goals or due cards degrade to "not known"; one course's evidence failing
 * leaves that course without skills while the others stay intact. The base read
 * (courses and tasks) is required and propagates its error.
 */
export function createLearnerSnapshotService(deps: LearnerSnapshotDeps) {
  const clock = deps.now ?? (() => new Date());
  return {
    async read(scope: Scope, input: { date: string; timeZone: string }): Promise<LearnerSnapshotRead> {
      const started = Date.now();
      const now = clock();
      const [base, prefs, dueCards] = await Promise.all([
        deps.readBase(scope),
        deps.readAdaptivePrefs(scope).then(
          (value) => ({ value, status: goalsStatus(value) }),
          (error: unknown) => {
            deps.onReadFailure?.("goals", error);
            return { value: null, status: "unavailable" as const };
          },
        ),
        deps.countDueCards(scope, { now, timeZone: input.timeZone }).then(
          (value) => ({ value, status: "available" as const }),
          (error: unknown) => {
            deps.onReadFailure?.("due_cards", error);
            return { value: 0, status: "unavailable" as const };
          },
        ),
      ]);
      const goals = prefs.status === "available" ? prefs.value!.prefs.courseGoals : {};
      const courses = await Promise.all(base.courses.map(async (course): Promise<SnapshotCourseSource> => {
        const shared = {
          courseId: course.courseId,
          title: course.title,
          goal: goals[course.courseId] ?? null,
          hasUsableMaterials: course.hasUsableMaterials,
          knowledgeNodes: toSnapshotKnowledgeNodes(course.knowledgeSnapshot),
        };
        try {
          const evidence = toSnapshotEvidence(await deps.readCourseEvidence(scope, course.courseId), now);
          return { ...shared, evidenceStatus: "available", ...evidence };
        } catch (error) {
          deps.onReadFailure?.("evidence", error, course.courseId);
          return { ...shared, evidenceStatus: "unavailable", summaries: [], observations: [] };
        }
      }));
      const sources: LearnerSnapshotSources = {
        date: input.date,
        timeZone: input.timeZone,
        courses,
        tasks: base.tasks.map((row) => toSnapshotTaskRow(row, input.timeZone)),
        dueCardCount: dueCards.value,
      };
      return {
        snapshot: deps.assembleSnapshot(sources),
        sources,
        autonomy: prefs.status === "unavailable" ? "manual" : prefs.value!.prefs.autonomy,
        dataStatus: {
          evidence: courses.some((course) => course.evidenceStatus === "unavailable") ? "unavailable" : "available",
          goals: prefs.status,
          dueCards: dueCards.status,
        },
        plannerInputRevision: learnerSnapshotRevision(sources),
        metrics: { reads: 3 + base.courses.length, durationMs: Date.now() - started },
      };
    },
  };
}

export type LearnerSnapshotService = ReturnType<typeof createLearnerSnapshotService>;
