import { uuidSchema } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  recommendTutorAction,
  assertNoMasteryPercentage,
  type ThinTutorAction,
} from "@aistudy/domain";
import { ApiError } from "../../auth/service";

const querySchema = z
  .object({
    skillLabel: z.string().min(1).max(200),
    currentPage: z.coerce.number().int().positive().nullable().optional(),
    nodeId: z.string().uuid().nullable().optional(),
    problemRef: z.string().min(1).max(240).nullable().optional(),
    sourceIds: z.string().optional(),
    sessionExposures: z.string().optional(),
    assistedSuccess: z
      .enum(["0", "1", "true", "false"])
      .optional()
      .transform((v) => v === "1" || v === "true"),
    retestDue: z
      .enum(["0", "1", "true", "false"])
      .optional()
      .transform((v) => v === "1" || v === "true"),
  })
  .strict();

export type TutorActionsQuery = z.infer<typeof querySchema>;

function parseSourceIds(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => uuidSchema.parse(id));
}

function parseExposures(
  raw: string | undefined,
): Array<"hinted" | "revealed"> {
  if (!raw || !raw.trim()) return [];
  const out: Array<"hinted" | "revealed"> = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (v === "hinted" || v === "revealed") out.push(v);
  }
  return out;
}

/** Pure recommendation for GET tutor-actions (no K01 / SkillEvidence required). */
export function buildTutorActions(input: {
  skillLabel: string;
  currentPage?: number | null;
  nodeId?: string | null;
  problemRef?: string | null;
  sourceIds: string[];
  sessionExposures: Array<"hinted" | "revealed">;
  assistedSuccessOnCurrentItem: boolean;
  retestDue: boolean;
}): ThinTutorAction[] {
  const action = recommendTutorAction({
    skillLabel: input.skillLabel,
    currentPage: input.currentPage ?? null,
    sourceIds: input.sourceIds,
    nodeId: input.nodeId ?? null,
    problemRef: input.problemRef ?? null,
    sessionExposures: input.sessionExposures,
    assistedSuccessOnCurrentItem: input.assistedSuccessOnCurrentItem,
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
  sessionExposures: Array<"hinted" | "revealed">;
} {
  const course = uuidSchema.parse(courseId);
  const parsed = querySchema.safeParse({
    skillLabel: searchParams.get("skillLabel") ?? undefined,
    currentPage: searchParams.get("currentPage"),
    nodeId: searchParams.get("nodeId"),
    problemRef: searchParams.get("problemRef"),
    sourceIds: searchParams.get("sourceIds") ?? undefined,
    sessionExposures: searchParams.get("sessionExposures") ?? undefined,
    assistedSuccess: searchParams.get("assistedSuccess") ?? undefined,
    retestDue: searchParams.get("retestDue") ?? undefined,
  });
  if (!parsed.success) {
    throw new ApiError("VALIDATION", parsed.error.message, 400);
  }
  return {
    courseId: course,
    query: parsed.data,
    sourceIds: parseSourceIds(parsed.data.sourceIds),
    sessionExposures: parseExposures(parsed.data.sessionExposures),
  };
}

/** Optional sql reserved for future L02 due lookups; K02a thin path is pure. */
export function listTutorActionsForCourse(
  _sql: Sql | null,
  courseId: string,
  searchParams: URLSearchParams,
): ThinTutorAction[] {
  const parsed = parseTutorActionsSearchParams(courseId, searchParams);
  return buildTutorActions({
    skillLabel: parsed.query.skillLabel,
    currentPage: parsed.query.currentPage ?? null,
    nodeId: parsed.query.nodeId ?? null,
    problemRef: parsed.query.problemRef ?? null,
    sourceIds: parsed.sourceIds,
    sessionExposures: parsed.sessionExposures,
    assistedSuccessOnCurrentItem: Boolean(parsed.query.assistedSuccess),
    retestDue: Boolean(parsed.query.retestDue),
  });
}
