import type { LearningObservation } from "@aistudy/contracts";
import type { RemindHandlerDeps } from "../jobs/remind";

export type ChamberRole = "logistics" | "teaching";

// Adapters bind the workspace and owner before issuing a chamber's ports.
export type TeachingChamberDeps = Readonly<{
  reserved_retest_items: (activityId: string) => Promise<readonly string[]>;
  hidden_answer_blocks: (itemVersionId: string) => Promise<readonly string[]>;
  recordFormalObservation: (observation: LearningObservation) => Promise<void>;
  mutateLearnerMastery: (requirementKey: string, observationId: string) => Promise<void>;
  gradeAssessmentAttempt: (attemptId: string) => Promise<LearningObservation>;
}>;

export type LogisticsChamberDeps = Readonly<{
  sendReminder: RemindHandlerDeps["send"];
}> & { readonly [K in keyof TeachingChamberDeps]?: never };
