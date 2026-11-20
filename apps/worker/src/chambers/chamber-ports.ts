import type { LearningObservation } from "@aistudy/contracts";
import type { JobHandler } from "../runtime/run-job";
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

type ReminderPorts = Required<Pick<RemindHandlerDeps, "record" | "isCurrent" | "externalConfig" | "resolveTimeZone">>;

export type LogisticsPorts = ReminderPorts & {
  sendReminder: RemindHandlerDeps["send"];
  indexSource: JobHandler;
  buildCourseKnowledge: JobHandler;
  extractStudyActions: JobHandler;
};

export type LogisticsChamberDeps = Readonly<LogisticsPorts> & { readonly [K in keyof TeachingChamberDeps]?: never };
