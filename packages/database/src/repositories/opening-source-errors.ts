export type OpeningSourceErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningSourceError extends Error {
  readonly code: OpeningSourceErrorCode;
  constructor(code: OpeningSourceErrorCode, message: string) {
    super(message);
    this.name = "OpeningSourceError";
    this.code = code;
  }
}
