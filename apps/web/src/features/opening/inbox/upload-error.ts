import { OpeningApiError } from "../client/api";

/** Only create this error with a local, user-facing explanation. */
export class UploadUserError extends Error {
  constructor(message: string) { super(message); this.name = "UploadUserError"; }
}

export function uploadErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof UploadUserError) return error.message;
  if (error instanceof OpeningApiError && error.status >= 400 && error.status < 500) {
    const message = error.message.trim().split(/\r?\n/, 1)[0]?.slice(0, 240);
    if (message && !message.startsWith("request failed")) return message;
  }
  return fallback;
}
