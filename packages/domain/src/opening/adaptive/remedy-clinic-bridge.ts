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
    const clinic = revalidateRemedyClinic(cachedClinic, activeSources, currentPrivacyEpoch);
    const { reason, strippedCaseCount, strippedProbeCount } = clinic.revocationSummary;
    // Partial source revocation also requires a fresh clinic for adaptive planning.
    return clinic.status === "active" && clinic.createdPrivacyEpoch === currentPrivacyEpoch
      && reason === "none" && strippedCaseCount === 0 && (strippedProbeCount ?? 0) === 0
      ? [{ clinic, skillLabel, ...(requirementKey !== undefined ? { requirementKey } : {}) }] : [];
  });
}
