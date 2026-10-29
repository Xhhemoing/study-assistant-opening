import type { Scope } from "@aistudy/contracts";
import type { ContextSourceRef, OpeningSpanTutorContext } from "@aistudy/database";
import { nextLearningStep, type NextLearningStep, type NextLearningStepInput } from "@aistudy/domain";
import { assertCurrentEpoch } from "../runtime/privacy-guard";

export type TutorNextAction = { activityId: string; sessionId: string; href: string };
export type TutorNextActionContext = {
  courseId: string;
  privacyEpoch: number;
  sourceRefs: ContextSourceRef[];
  decisionInput: NextLearningStepInput;
  resume?: TutorNextAction;
  /** Server-only adapter state, including the grant and exact activity revision. */
  spanContext?: OpeningSpanTutorContext;
  unavailableAction?: { message: string; label: string; href: string };
  resumeRequiresExecution?: boolean;
  historicalDecision?: NextLearningStep | null;
};
export type TutorNextActionRequest = {
  courseId: string; sourceIds: readonly string[]; sourceVersions: Record<string, number>;
  userTurnId: string; question: string; operationId: string; expectedPrivacyEpoch?: number;
  jobLease?: { jobId: string; claimToken: string };
};
/** The service owns authorization and atomically rechecks it when executing. */
export type TutorNextActionService = {
  read(scope: Scope, request: TutorNextActionRequest): Promise<TutorNextActionContext | null>;
  assertCurrent(scope: Scope, context: TutorNextActionContext): Promise<void>;
  execute(scope: Scope, input: TutorNextActionRequest & { context: TutorNextActionContext; decision: NextLearningStep }): Promise<TutorNextAction>;
};
export type PreparedTutorNextAction = {
  context: TutorNextActionContext;
} & ({ decision: NextLearningStep | null; resumed: true; action: TutorNextAction; choice?: never }
  | { decision: NextLearningStep; resumed: false; action: TutorNextAction; choice?: never }
  | { decision: NextLearningStep; resumed: false; action: null; choice: NonNullable<TutorNextActionContext["unavailableAction"]> });

export async function prepareTutorNextAction(service: TutorNextActionService, scope: Scope, request: TutorNextActionRequest): Promise<PreparedTutorNextAction | null> {
  const context = await service.read(scope, request);
  if (!context) return null;
  if (request.expectedPrivacyEpoch !== undefined) assertCurrentEpoch(request.expectedPrivacyEpoch, context.privacyEpoch);
  await service.assertCurrent(scope, context);
  if (context.resume && !context.resumeRequiresExecution && !context.unavailableAction)
    return { context, action: context.resume, decision: context.historicalDecision ?? null, resumed: true };
  const decision = nextLearningStep(context.decisionInput);
  if (context.unavailableAction) return { context, action: null, decision, resumed: false, choice: context.unavailableAction };
  const action = context.resume && !context.resumeRequiresExecution ? context.resume : await service.execute(scope, { ...request, context, decision });
  return { context, action, decision, resumed: false };
}
