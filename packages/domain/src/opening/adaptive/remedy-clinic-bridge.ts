import {
  generateRemedyClinic,
  revalidateRemedyClinic,
  type ActiveSourcesMap,
  type GenerateRemedyClinicInput,
  type RemedyClinicSessionV1,
} from "../../remedy-clinic";

export type AdaptiveRemedyClinicCandidate = {
  clinic: RemedyClinicSessionV1;
  skillLabel: string;
  requirementKey?: string | null;
};

/** Current workspace authority supplied for this planning read. */
export type AdaptiveRemedyClinicValidation = {
  readonly currentPrivacyEpoch: number;
  readonly activeSources: ActiveSourcesMap;
};

function isUnrevokedClinic(clinic: RemedyClinicSessionV1): boolean {
  // Read cached data properties without invoking accessors before engine validation.
  try {
    if (Object.getOwnPropertyDescriptor(clinic, "status")?.value !== "active") return false;
    const summary: unknown = Object.getOwnPropertyDescriptor(clinic, "revocationSummary")?.value;
    if (!summary || typeof summary !== "object") return false;
    const reason = Object.getOwnPropertyDescriptor(summary, "reason")?.value;
    const strippedCases = Object.getOwnPropertyDescriptor(summary, "strippedCaseCount")?.value;
    const strippedProbes = Object.getOwnPropertyDescriptor(summary, "strippedProbeCount");
    return reason === "none" && strippedCases === 0
      && (!strippedProbes || (Object.hasOwn(strippedProbes, "value") && (strippedProbes.value ?? 0) === 0));
  } catch {
    return false;
  }
}

export function generateAdaptiveRemedyClinic<TInput, TObservable>(
  input: GenerateRemedyClinicInput<TInput, TObservable>,
  target: Pick<AdaptiveRemedyClinicCandidate, "skillLabel" | "requirementKey">,
): AdaptiveRemedyClinicCandidate | null {
  const { clinic } = generateRemedyClinic(input);
  const { skillLabel, requirementKey } = target;
  return clinic && { clinic, skillLabel, ...(requirementKey !== undefined ? { requirementKey } : {}) };
}

export function revalidateAdaptiveRemedyClinics(
  candidates: readonly AdaptiveRemedyClinicCandidate[],
  validation?: AdaptiveRemedyClinicValidation,
): AdaptiveRemedyClinicCandidate[] {
  if (!validation) return [];
  const { activeSources, currentPrivacyEpoch } = validation;
  return candidates.flatMap(({ clinic: cachedClinic, skillLabel, requirementKey }) => {
    // Revalidation can clear a prior partial revocation after the affected evidence was removed.
    if (!isUnrevokedClinic(cachedClinic)) return [];
    const clinic = revalidateRemedyClinic(cachedClinic, activeSources, currentPrivacyEpoch);
    return clinic.createdPrivacyEpoch === currentPrivacyEpoch && isUnrevokedClinic(clinic)
      ? [{ clinic, skillLabel, ...(requirementKey !== undefined ? { requirementKey } : {}) }] : [];
  });
}
