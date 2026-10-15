import type { PlanAcceptConflictReason } from "@aistudy/contracts";

export type OpeningPlanErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningPlanError extends Error {
  readonly code: OpeningPlanErrorCode;
  /** Set on CONFLICT when a draft acceptance is refused; returned to the client as `reason`. */
  readonly reason?: PlanAcceptConflictReason;
  constructor(code: OpeningPlanErrorCode, message: string, reason?: PlanAcceptConflictReason) {
    super(message);
    this.name = "OpeningPlanError";
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}
