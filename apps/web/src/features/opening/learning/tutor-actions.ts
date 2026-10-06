import { uuidSchema, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  recommendTutorAction,
  assertNoMasteryPercentage,
  type ThinTutorAction,
} from "@aistudy/domain";
import {
  createOpeningLearningRepository,
  createOpeningRetestActivityRepository,
} from "@aistudy/database";
import { ApiError } from "../../auth/service";

const allowedQueryKeys = new Set([
  "skillLabel",
  "sessionId",
  "currentPage",
  "nodeId",
  "sourceIds",
]);

const querySchema = z.object({
  skillLabel: z.string().min(1).max(200),
  sessionId: z.string().uuid().nullable().optional(),
  currentPage: z.coerce.number().int().positive().nullable().optional(),
  nodeId: z.string().uuid().nullable().optional(),
  sourceIds: z.string().optional(),
});

export type TutorActionsQuery = z.infer<typeof querySchema>;

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
};

function createDefaultObservationDeps(sql: Sql): TutorActionObservationDeps {
  const learning = createOpeningLearningRepository(sql);
  const retests = createOpeningRetestActivityRepository(sql);
  return {
    assertOwnedCourse: (scope, courseId) => learning.assertOwnedCourse(scope, courseId),
    getSession: (scope, sessionId) => learning.getSession(scope, sessionId),
    listDeliveredExposures: (scope, sessionId) => learning.listDeliveredExposures(scope, sessionId),
    listDueRetests: (scope, courseId, now) => retests.listDue(scope, courseId, now),
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

/** Pure recommendation wrapper; all observation inputs are server-derived. */
export function buildTutorActions(input: {
  skillLabel: string;
  currentPage?: number | null;
  nodeId?: string | null;
  sourceIds: string[];
  sessionExposures: Array<"hinted" | "revealed">;
  retestDue: boolean;
}): ThinTutorAction[] {
  const action = recommendTutorAction({
    skillLabel: input.skillLabel,
    currentPage: input.currentPage ?? null,
    sourceIds: input.sourceIds,
    nodeId: input.nodeId ?? null,
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
  const unknownKeys = [...searchParams.keys()].filter((key) => !allowedQueryKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ApiError(
      "VALIDATION",
      `Unrecognized query parameter: ${unknownKeys[0]}`,
      400,
    );
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
  const dueRetests = await deps.listDueRetests(scope, parsed.courseId, new Date().toISOString());
  const retestDue = dueRetests.some(
    (activity) => activity.skillLabel === parsed.query.skillLabel,
  );
  return buildTutorActions({
    skillLabel: parsed.query.skillLabel,
    currentPage: parsed.query.currentPage ?? null,
    nodeId: parsed.query.nodeId ?? null,
    sourceIds: parsed.sourceIds,
    sessionExposures: exposures,
    retestDue,
  });
}
