import { OpeningApiError } from "../client/api";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { TUTOR_MODEL_SETUP_MESSAGE } from "@aistudy/domain";

/** Where the learner fixes "no usable model". */
export const MODEL_SETUP_HREF = "/opening/settings#quick-model-setup";

/** Validate an optional physical page against scope-authorized, parse-ready chunks. */
export function formatTurnError(err: unknown): string {
  if (err instanceof OpeningApiError) {
    if (err.code === "page_not_in_sources") {
      return "这一页在材料里找不到对应内容。如果材料还在处理中，可以先清空页码再提问。";
    }
    if (err.code === "chunk_not_in_sources") {
      return "所选片段不在指定材料中。";
    }
    if (err.code === "page_chunk_mismatch") {
      return "页码与片段不一致。";
    }
    if (err.code === "AI_MODEL_UNAVAILABLE" || err.code === "PROVIDER_DISABLED") return TUTOR_MODEL_SETUP_MESSAGE;
    if (err.code?.startsWith("PROVIDER_")) return "AI 服务暂时没有响应，请稍后再试。";
    if (err.code === "BUDGET_EXCEEDED" || err.code === "REQUEST_CAP_EXCEEDED") return userFacingMessage(err, "今日 AI 用量已达上限，请明天再试或到设置调整额度。");
  }
  return userFacingMessage(err, "发送失败，请重试。");
}

/** Omit currentPage when unset; keep explicit page for server check. */
export function pageForSubmit(currentPage: string): number | null | undefined {
  const trimmed = currentPage.trim();
  if (trimmed === "") return undefined;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("当前页必须是正整数物理页码");
  }
  return n;
}
