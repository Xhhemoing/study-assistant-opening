import { userFacingMessage } from "../../../lib/user-facing-error";
import { OpeningApiError } from "../client/api";

/** Only create this error with a local, user-facing explanation. */
export class UploadUserError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "UploadUserError";
    this.code = code;
  }
}

function fallbackByCode(code: string | null): string | undefined {
  switch (code) {
    case "UPLOAD_MISMATCH":
      return "文件内容与扩展名不匹配，或暂存文件尚未就绪，请确认后重试。";
    case "CONFLICT":
      return "材料状态或上传凭证已发生变化，请刷新后重试。";
    case "NOT_FOUND":
      return "未找到对应的上传记录，请重新选择文件上传。";
    default:
      return undefined;
  }
}

export function uploadErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof UploadUserError) return error.message;
  if (error instanceof OpeningApiError && error.status >= 400 && error.status < 500) {
    const firstLine = error.message.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 240) ?? "";
    const safeMessage = firstLine ? userFacingMessage(new Error(firstLine), "") : "";
    if (safeMessage) return safeMessage;
    return fallbackByCode(error.code) ?? fallback;
  }
  return fallback;
}
