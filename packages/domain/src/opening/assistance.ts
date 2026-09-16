import {
  assistanceLevelSchema,
  observationAllowsIndependent,
} from "@aistudy/contracts";
import type { z } from "zod";

export type AssistanceLevel = z.infer<typeof assistanceLevelSchema>;
export type HelpExposureLevel = "hinted" | "revealed";
export type ObservationOutcome = "correct" | "incorrect" | "unverified";

/**
 * Client cannot erase server-known exposure for the SAME session.
 * Only delivered exposures should be passed in (HelpExposure.delivered === true).
 */
export function resolveAssistance(
  declared: AssistanceLevel,
  exposures: ReadonlyArray<HelpExposureLevel>,
): AssistanceLevel {
  if (exposures.includes("revealed")) return "revealed";
  if (exposures.includes("hinted")) return "hinted";
  return declared;
}

/** Thin wrapper used by L01 observation services. */
export function qualifyObservationAssistance(input: {
  declared: AssistanceLevel;
  exposures: ReadonlyArray<HelpExposureLevel>;
  problemId?: string | null;
  outcome: ObservationOutcome;
}): {
  assistance: AssistanceLevel;
  allowsIndependent: boolean;
} {
  const assistance = resolveAssistance(input.declared, input.exposures);
  const allowsIndependent = observationAllowsIndependent({
    problemId: input.problemId,
    assistance,
    outcome: input.outcome,
  });
  return { assistance, allowsIndependent };
}
