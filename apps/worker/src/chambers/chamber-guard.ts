import type { ChamberRole, LogisticsChamberDeps, TeachingChamberDeps } from "./chamber-ports";

const teachingPorts = {
  reserved_retest_items: true,
  hidden_answer_blocks: true,
  recordFormalObservation: true,
  mutateLearnerMastery: true,
  gradeAssessmentAttempt: true,
} satisfies Record<keyof TeachingChamberDeps, true>;

export class ChamberSovereigntyViolationError extends Error {
  constructor(readonly chamber: ChamberRole, readonly port: string) {
    super(`Chamber ${chamber} cannot access ${port}`);
    this.name = "ChamberSovereigntyViolationError";
  }
}

export function assertChamberAccess(chamber: ChamberRole, port: string): void {
  if (chamber === "logistics" && port === "sendReminder") return;
  if (chamber === "teaching" && Object.hasOwn(teachingPorts, port)) return;
  throw new ChamberSovereigntyViolationError(chamber, port);
}

/** Copy only the allowed operation, without enumerating the caller's other ports or getters. */
export function createLogisticsChamberDeps({ sendReminder }: Pick<LogisticsChamberDeps, "sendReminder">): LogisticsChamberDeps {
  const deps = {
    __proto__: null,
    sendReminder: (...args: Parameters<typeof sendReminder>) => sendReminder(...args),
  };
  return Object.freeze(deps);
}
