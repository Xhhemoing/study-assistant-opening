import { uuidSchema, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  recommendTutorAction,
  assertNoMasteryPercentage,
  decideIntervention,
  gateTutorRecommendAfterDecision,
  type ThinTutorAction,
  type AdaptiveTutorActionKind,
} from "@aistudy/domain";
import type { InterventionSettingsResponse } from "@aistudy/contracts";
import {
  createOpeningLearningRepository,
  createOpeningSkillEvidenceRepository,
  createOpeningRetestActivityRepository,
  createOpeningInterventionSettingsRepository,
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
};

export type TutorActionSkillEvidenceDeps = {
  flagsForNode(scope: Scope, courseId: string, nodeId: string): Promise<NodeSkillEvidenceFlagsView>;
};

export type TutorActionObservationDeps = {
  assertOwnedCourse(scope: Scope, courseId: string): Promise<void>;
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
  clarify: "No reliable SkillEvidence for this node yet; clarify the target first.",
  guided: "Material-linked node selected; start with a next-step guided hint.",
  worked_example: "Offer a full worked example if still stuck.",
};

/** Pure recommendation wrapper; all observation inputs are server-derived. */
export function buildTutorActions(input: {
  skillLabel: string;
  currentPage?: number | null;
  nodeId?: string | null;
  sourceIds: string[];
  sessionExposures: Array<"hinted" | "revealed">;
  retestDue: boolean;
  hasAssistance?: boolean;
  hasCheckedIndependent?: boolean;
  evidenceIds?: string[];
}): ThinTutorAction[] {
  if (input.nodeId) {
    const kind = recommendTutorAction({
      nodeId: input.nodeId,
      hasAssistance: input.hasAssistance ?? false,
      hasCheckedIndependent: input.hasCheckedIndependent ?? false,
      retestDue: input.retestDue,
    });
    const action: ThinTutorAction = {
      kind,
      skillLabel: input.skillLabel.trim(),
      currentPage: input.currentPage ?? null,
      nodeId: input.nodeId,
      problemRef: kind === "independent_variant" ? "variant:1" : null,
      reason: adaptiveReason[kind],
      evidenceIds: input.evidenceIds ?? [],
    };
    assertNoMasteryPercentage({ ...action } as Record<string, unknown>);
    return [action];
  }

  const action = recommendTutorAction({
    skillLabel: input.skillLabel,
    currentPage: input.currentPage ?? null,
    sourceIds: input.sourceIds,
    nodeId: null,
    sessionExposures: input.sessionExposures,
    // B02 is intentionally not implemented; v1 has no micro-question path.
    assistedSuccessOnCurrentItem: false,
    retestDue: input.retestDue,
    evidenceIds: [],
  });
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
  const dueRetests = await deps.listDueRetests(
    scope,
    parsed.courseId,
    new Date().toISOString(),
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
  if (nodeId) {
    const flags = await deps.flagsForNode(scope, parsed.courseId, nodeId);
    return gate(buildTutorActions({
      skillLabel: parsed.query.skillLabel,
      currentPage: parsed.query.currentPage ?? null,
      nodeId,
      sourceIds: parsed.sourceIds,
      sessionExposures: exposures,
      retestDue,
      hasAssistance: flags.hasAssistance,
      hasCheckedIndependent: flags.hasCheckedIndependent,
      evidenceIds: flags.evidenceIds,
    }), "prompt", flags.hasAssistance || flags.hasCheckedIndependent ? "ok" : "low");
  }

  return gate(buildTutorActions({
    skillLabel: parsed.query.skillLabel,
    currentPage: parsed.query.currentPage ?? null,
    nodeId: null,
    sourceIds: parsed.sourceIds,
    sessionExposures: exposures,
    retestDue,
  }), "teach", "ok");
}
