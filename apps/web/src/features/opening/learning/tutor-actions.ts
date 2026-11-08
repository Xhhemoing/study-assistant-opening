import { uuidSchema, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  buildDecisionInput,
  nextLearningStep,
  normalizeSkillLabelKey,
  toSnapshotEvidence,
  assertNoMasteryPercentage,
  decideIntervention,
  gateTutorRecommendAfterDecision,
  type ThinTutorAction,
  type AdaptiveTutorActionKind,
  type CourseEvidence,
  type NextLearningStep,
  type SnapshotObservation,
} from "@aistudy/domain";
import type { InterventionSettingsResponse } from "@aistudy/contracts";
import {
  createOpeningLearningRepository,
  createOpeningSkillEvidenceRepository,
  createOpeningRetestActivityRepository,
  createOpeningInterventionSettingsRepository,
  readOpeningCourseEvidence,
} from "@aistudy/database";
import { ApiError } from "../../auth/service";

const allowedQueryKeys = new Set([
  "skillLabel",
  "sessionId",
  "currentPage",
  "nodeId",
  "sourceIds",
]);

/** Client must never self-report observation / SkillEvidence flags. */
const forbiddenObservationQueryKeys = new Set([
  "hasCheckedIndependent",
  "hasAssistance",
  "sessionExposures",
  "assistedSuccess",
  "assistedSuccessOnCurrentItem",
  "retestDue",
]);

const querySchema = z.object({
  skillLabel: z.string().min(1).max(200),
  sessionId: z.string().uuid().nullable().optional(),
  currentPage: z.coerce.number().int().positive().nullable().optional(),
  nodeId: z.string().uuid().nullable().optional(),
  sourceIds: z.string().optional(),
});

export type TutorActionsQuery = z.infer<typeof querySchema>;

export type NodeSkillEvidenceFlagsView = {
  hasAssistance: boolean;
  hasCheckedIndependent: boolean;
  evidenceIds: string[];
  observationIds: string[];
};

export type TutorActionSkillEvidenceDeps = {
  flagsForNode(scope: Scope, courseId: string, nodeId: string): Promise<NodeSkillEvidenceFlagsView>;
};

export type TutorActionObservationDeps = {
  assertOwnedCourse(scope: Scope, courseId: string): Promise<void>;
  readCourseEvidence(scope: Scope, courseId: string): Promise<CourseEvidence>;
  getSession(scope: Scope, sessionId: string): Promise<{
    id: string;
    courseId: string;
  } | null>;
  listDeliveredExposures(
    scope: Scope,
    sessionId: string,
  ): Promise<Array<"hinted" | "revealed">>;
  listDueRetests(
    scope: Scope,
    courseId: string,
    now: string,
  ): Promise<Array<{ skillLabel?: string | null }>>;
  getIntervention?(scope: Scope, courseId: string, activityId: string | null): Promise<InterventionSettingsResponse>;
} & TutorActionSkillEvidenceDeps;

function createDefaultObservationDeps(sql: Sql): TutorActionObservationDeps {
  const learning = createOpeningLearningRepository(sql);
  const retests = createOpeningRetestActivityRepository(sql);
  const skillEvidence = createOpeningSkillEvidenceRepository(sql);
  return {
    assertOwnedCourse: (scope, courseId) => learning.assertOwnedCourse(scope, courseId),
    readCourseEvidence: (scope, courseId) => readOpeningCourseEvidence(sql, scope, courseId),
    getSession: (scope, sessionId) => learning.getSession(scope, sessionId),
    listDeliveredExposures: (scope, sessionId) =>
      learning.listDeliveredExposures(scope, sessionId),
    listDueRetests: (scope, courseId, now) => retests.listDue(scope, courseId, now),
    getIntervention: (scope, courseId, activityId) =>
      createOpeningInterventionSettingsRepository(sql).resolve(scope, { courseId, activityId }),
    flagsForNode: (scope, courseId, nodeId) => skillEvidence.flagsForNode(scope, courseId, nodeId),
  };
}

function parseSourceIds(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => uuidSchema.parse(id));
}

/** Highest-level exposure history; a later hint must not mask revealed. */
export function aggregateHighestExposure(
  exposures: ReadonlyArray<"hinted" | "revealed">,
): Array<"hinted" | "revealed"> {
  return exposures.includes("revealed")
    ? ["revealed"]
    : exposures.includes("hinted")
      ? ["hinted"]
      : [];
}

const adaptiveReason: Record<AdaptiveTutorActionKind, string> = {
  delayed_retest:
    "L02 delayed retest is due; start a new session with empty exposure.",
  independent_variant:
    "Assisted or prior independent evidence for this node; try a new independent variant.",
  clarify: "No reliable current evidence yet; clarify the target first.",
  guided: "Current evidence identifies an error; start with a next-step guided hint.",
  worked_example: "Offer a full worked example if still stuck.",
};

const actionKind: Record<Exclude<NextLearningStep["activityKind"], "transfer_check">, AdaptiveTutorActionKind> = {
  diagnose: "clarify",
  targeted_explain: "guided",
  full_explain: "worked_example",
  reduced_help_practice: "independent_variant",
};

/** Matches the client thinTutorActionSchema limit; only response references are bounded. */
const MAX_TUTOR_ACTION_EVIDENCE_IDS = 200;

/** Pure seam over server-scoped, canonical snapshot evidence; material/exposure is not a score. */
export function buildTutorActions(input: {
  skillLabel: string;
  currentPage?: number | null;
  nodeId?: string | null;
  observations: readonly SnapshotObservation[];
  retestDue: boolean;
  /** Node responses retain SkillEvidence link IDs, not internal observation IDs. */
  evidenceIds?: string[];
}): ThinTutorAction[] {
  const decisionInput = buildDecisionInput({
    observations: input.observations,
    wantsFullExplanation: false,
    dueRetest: input.retestDue,
  });
  const next = nextLearningStep(decisionInput);
  const kind = next.activityKind === "transfer_check"
    ? input.retestDue ? "delayed_retest" : "independent_variant"
    : actionKind[next.activityKind];
  const action: ThinTutorAction = {
    kind,
    skillLabel: input.skillLabel.trim(),
    currentPage: input.currentPage ?? null,
    nodeId: input.nodeId ?? null,
    problemRef: kind === "independent_variant" ? "variant:1" : null,
    reason: adaptiveReason[kind],
    evidenceIds: [...new Set(input.evidenceIds ?? decisionInput.observations
      .filter(row => row.usableForCurrentVersion === "yes").map(row => row.id))]
      .slice(0, MAX_TUTOR_ACTION_EVIDENCE_IDS),
  };
  assertNoMasteryPercentage({ ...action } as Record<string, unknown>);
  return [action];
}

export function parseTutorActionsSearchParams(
  courseId: string,
  searchParams: URLSearchParams,
): {
  courseId: string;
  query: TutorActionsQuery;
  sourceIds: string[];
} {
  const course = uuidSchema.parse(courseId);
  for (const key of searchParams.keys()) {
    if (forbiddenObservationQueryKeys.has(key)) {
      throw new ApiError(
        "VALIDATION",
        `Client must not self-report observation flag: ${key}`,
        400,
      );
    }
    if (!allowedQueryKeys.has(key)) {
      throw new ApiError(
        "VALIDATION",
        `Unrecognized query parameter: ${key}`,
        400,
      );
    }
  }
  const parsed = querySchema.safeParse({
    skillLabel: searchParams.get("skillLabel") ?? undefined,
    sessionId: searchParams.get("sessionId") ?? undefined,
    currentPage: searchParams.get("currentPage"),
    nodeId: searchParams.get("nodeId"),
    sourceIds: searchParams.get("sourceIds") ?? undefined,
  });
  if (!parsed.success) {
    throw new ApiError("VALIDATION", parsed.error.message, 400);
  }
  return {
    courseId: course,
    query: parsed.data,
    sourceIds: parseSourceIds(parsed.data.sourceIds),
  };
}

export async function listTutorActionsForCourse(
  sql: Sql,
  scope: Scope,
  courseId: string,
  searchParams: URLSearchParams,
  deps: TutorActionObservationDeps = createDefaultObservationDeps(sql),
): Promise<ThinTutorAction[]> {
  const parsed = parseTutorActionsSearchParams(courseId, searchParams);
  await deps.assertOwnedCourse(scope, parsed.courseId);
  const intervention = deps.getIntervention ? await deps.getIntervention(scope, parsed.courseId, null) : null;
  let exposures: Array<"hinted" | "revealed"> = [];
  if (parsed.query.sessionId) {
    const session = await deps.getSession(scope, parsed.query.sessionId);
    if (!session || session.courseId !== parsed.courseId) {
      throw new ApiError("NOT_FOUND", "learning session not found", 404);
    }
    exposures = aggregateHighestExposure(
      await deps.listDeliveredExposures(scope, parsed.query.sessionId),
    );
  }
  const now = new Date();
  const evidence = await deps.readCourseEvidence(scope, parsed.courseId);
  const snapshot = toSnapshotEvidence(evidence, now);
  const dueRetests = await deps.listDueRetests(
    scope,
    parsed.courseId,
    now.toISOString(),
  );
  const retestDue = dueRetests.some(
    (activity) => activity.skillLabel === parsed.query.skillLabel,
  );

  const gate = (actions: ThinTutorAction[], nodeKind: "teach" | "prompt", evidenceStrength: "low" | "ok") => {
    if (!intervention) return actions;
    const decision = decideIntervention({ prefs: intervention.effective, trigger: "tutor_recommend", context: {
      userIsTyping: false, consecutiveProactiveRejects: 0, evidenceStrength, nodeKind,
      sessionExposures: exposures, proposedKind: actions[0]?.kind,
    }});
    return gateTutorRecommendAfterDecision(actions[0]?.kind, decision).allowOffer ? actions : [];
  };

  const nodeId = parsed.query.nodeId ?? null;
  const flags = nodeId ? await deps.flagsForNode(scope, parsed.courseId, nodeId) : null;
  const nodeObservationIds = new Set(flags?.observationIds);
  const observations = snapshot.observations.filter(row => nodeId
    ? nodeObservationIds.has(row.id)
    : normalizeSkillLabelKey(row.skillLabel) === normalizeSkillLabelKey(parsed.query.skillLabel));
  return gate(buildTutorActions({
    skillLabel: parsed.query.skillLabel,
    currentPage: parsed.query.currentPage ?? null,
    nodeId,
    observations,
    retestDue,
    ...(flags ? { evidenceIds: flags.evidenceIds } : {}),
  }), nodeId ? "prompt" : "teach", !nodeId || observations.some(row => row.usableForCurrentVersion === "yes") ? "ok" : "low");
}
