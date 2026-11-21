import type { ChamberRole, LogisticsChamberDeps, LogisticsPorts, TeachingChamberDeps } from "./chamber-ports";

const teachingPorts = {
  reserved_retest_items: true,
  hidden_answer_blocks: true,
  recordFormalObservation: true,
  mutateLearnerMastery: true,
  gradeAssessmentAttempt: true,
} satisfies Record<keyof TeachingChamberDeps, true>;

const logisticsPorts = {
  record: true, isCurrent: true, externalConfig: true, resolveTimeZone: true, sendReminder: true,
  indexSource: true, buildCourseKnowledge: true, extractStudyActions: true,
} satisfies Record<keyof LogisticsPorts, true>;

export class ChamberSovereigntyViolationError extends Error {
  constructor(readonly chamber: ChamberRole, readonly port: string) {
    super(`Chamber ${chamber} cannot access ${port}`);
    this.name = "ChamberSovereigntyViolationError";
  }
}

export function assertChamberAccess(chamber: ChamberRole, port: string): void {
  if (chamber === "logistics" && Object.hasOwn(logisticsPorts, port)) return;
  if (chamber === "teaching" && Object.hasOwn(teachingPorts, port)) return;
  throw new ChamberSovereigntyViolationError(chamber, port);
}

/** Copy only the allowed operation, without enumerating the caller's other ports or getters. */
export function createLogisticsChamberDeps({
  sendReminder, record, isCurrent, externalConfig, resolveTimeZone, indexSource, buildCourseKnowledge, extractStudyActions,
}: LogisticsPorts): LogisticsChamberDeps {
  const deps: LogisticsPorts & { __proto__: null } = {
    __proto__: null,
    sendReminder: (...args) => sendReminder(...args),
    record: (...args) => record(...args),
    isCurrent: (...args) => isCurrent(...args),
    externalConfig: (...args) => externalConfig(...args),
    resolveTimeZone: (...args) => resolveTimeZone(...args),
    indexSource: (...args) => indexSource(...args),
    buildCourseKnowledge: (...args) => buildCourseKnowledge(...args),
    extractStudyActions: (...args) => extractStudyActions(...args),
  };
  return Object.freeze(deps);
}
