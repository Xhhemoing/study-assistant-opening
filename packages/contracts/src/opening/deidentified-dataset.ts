/** Content-free research metadata, never a backup or a promise of model unlearning. */
export const OPENING_DATASET_POLICY_VERSION = "opening-dataset-v1" as const;
export type OpeningDatasetConsentInput = {
  policyVersion: typeof OPENING_DATASET_POLICY_VERSION;
  consented: true;
  expiresAt: string;
};
export type OpeningDeidentifiedDataset = {
  version: 1;
  privacyEpoch: number;
  dialogueEvaluation: Array<{ identity: string; sequence: string; position: number; role: "user" | "assistant"; complete: boolean; sources: string[] }>;
  answerSequences: Array<{ identity: string; sequence: string; position: number; submitted: boolean; outcome: "correct" | "incorrect" | "partial" | "unknown"; sources: string[] }>;
  coursePackageQuality: Array<{ identity: string; generated: boolean; sourceCount: number; sources: string[] }>;
};
