import {
  assistanceLevelSchema,
  observationAllowsIndependent,
} from "@aistudy/contracts";
import type { z } from "zod";
import { exposuresAffectingItemAssistance } from "./teaching-exposure";

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

export type KindedHelpExposureLevel = {
  level: HelpExposureLevel;
  kind?: "instruction" | "hint" | "solution" | null;
};

/**
 * Resolve assistance from kind-aware exposures.
 * Instruction kind is ignored for item assistance elevation (V2-13).
 */
export function resolveAssistanceFromExposures(
  declared: AssistanceLevel,
  exposures: ReadonlyArray<KindedHelpExposureLevel | HelpExposureLevel>,
): AssistanceLevel {
  const levels = exposuresAffectingItemAssistance(
    exposures.map((row) => (typeof row === "string" ? { level: row, kind: "hint" as const } : row)),
  ).map((row) => row.level);
  return resolveAssistance(declared, levels);
}

/** Thin wrapper used by L01 observation services. */
export function qualifyObservationAssistance(input: {
  declared: AssistanceLevel;
  exposures: ReadonlyArray<HelpExposureLevel | KindedHelpExposureLevel>;
  problemId?: string | null;
  outcome: ObservationOutcome;
}): {
  assistance: AssistanceLevel;
  allowsIndependent: boolean;
} {
  const assistance = resolveAssistanceFromExposures(input.declared, input.exposures);
  const allowsIndependent = observationAllowsIndependent({
    problemId: input.problemId,
    assistance,
    outcome: input.outcome,
  });
  return { assistance, allowsIndependent };
}
