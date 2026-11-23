import {
  generateRemedyClinic,
  revalidateRemedyClinic,
  type ActiveSourcesMap,
  type GenerateRemedyClinicInput,
  type RemedyClinicSessionV1,
} from "../../remedy-clinic";

export type AdaptiveRemedyClinicCandidate = {
  clinic: RemedyClinicSessionV1;
  currentPrivacyEpoch: number;
  activeSources: ActiveSourcesMap;
  skillLabel: string;
  requirementKey?: string | null;
};

export function generateAdaptiveRemedyClinic<TInput, TObservable>(
  input: GenerateRemedyClinicInput<TInput, TObservable>,
  target: Pick<AdaptiveRemedyClinicCandidate, "skillLabel" | "requirementKey">,
): AdaptiveRemedyClinicCandidate | null {
  const { clinic } = generateRemedyClinic(input);
  return clinic && {
    ...target, clinic,
    currentPrivacyEpoch: input.currentPrivacyEpoch,
    activeSources: input.activeSourcesMap,
  };
}

export function revalidateAdaptiveRemedyClinics(
  candidates: readonly AdaptiveRemedyClinicCandidate[],
): AdaptiveRemedyClinicCandidate[] {
  return candidates.flatMap(candidate => {
    const clinic = revalidateRemedyClinic(candidate.clinic, candidate.activeSources, candidate.currentPrivacyEpoch);
    // A new privacy epoch requires a fresh clinic for adaptive planning.
    return clinic.status === "active" && clinic.createdPrivacyEpoch === candidate.currentPrivacyEpoch
      ? [{ ...candidate, clinic }] : [];
  });
}
