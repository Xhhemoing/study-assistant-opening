export type OpeningPlanErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningPlanError extends Error {
  readonly code: OpeningPlanErrorCode;
  constructor(code: OpeningPlanErrorCode, message: string) {
    super(message);
    this.name = "OpeningPlanError";
    this.code = code;
  }
}
