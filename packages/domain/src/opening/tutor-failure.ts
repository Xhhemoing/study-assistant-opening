import type { TutorJobError } from "@aistudy/contracts";
import { PAGE_CITATION_CLARIFY_MESSAGE } from "./tutor-policy";

export const TUTOR_FAILURE_MESSAGE = "本轮回答未能完成。请先重新读取会话状态，再决定是否重新提问。";
export const TUTOR_UNKNOWN_MESSAGE = "本轮执行结果尚未确认，费用也待核对；为避免重复调用，未自动重发。";
export const TUTOR_CANCELLED_MESSAGE = "回答任务已取消。";

const knownFailureMessages: Readonly<Record<string, string>> = {
  BUDGET_EXCEEDED: "今日 AI 预算已达上限，请在设置中核对预算，或明天再试。",
  REQUEST_CAP_EXCEEDED: "该模型今天的请求次数已达上限；可在设置中为该用途指定备用模型。",
  PARENT_BUDGET_EXCEEDED: "本轮交互的预算已达上限，已停止继续调用。请核对本轮结果与预算。",
  PARENT_BUDGET_CALL_LIMIT: "本轮交互的调用次数已达上限，已停止继续调用。请核对本轮已有结果。",
  PARENT_BUDGET_BLOCKED: "本轮交互的费用超出预算限制，已停止继续调用。请在设置中核对费用与预算。",
  PARENT_BUDGET_OUTCOME_UNKNOWN: TUTOR_UNKNOWN_MESSAGE,
  BUDGET_OUTCOME_UNKNOWN: TUTOR_UNKNOWN_MESSAGE,
  BUDGET_EXECUTION_CLAIMED: TUTOR_UNKNOWN_MESSAGE,
  AI_ROUTE_UNAVAILABLE: "所选模型暂时无法用于本次提问，请在设置中核对模型、输入能力与预算。",
  VISION_INPUT_REQUIRED: "当前模型不能看图，请在设置中选择支持图片的模型",
  PROVIDER_DISABLED: "AI 服务尚未启用，请在设置中配置模型后再试。",
  PROVIDER_AUTH: "AI 服务授权失败，请在设置中核对该服务的密钥。",
  PROVIDER_RATE_LIMIT: "AI 服务当前请求过多，请稍后再试。",
  PROVIDER_MEDIA_UNSUPPORTED: "所选模型无法处理本次材料，请选择支持该材料类型的模型。",
  PROVIDER_PAYLOAD_TOO_LARGE: "本次材料超出模型的输入限制，请缩小材料范围后再试。",
  BUDGET_MEDIA_COST_UNBOUNDED: "当前模型未配置可核验的媒体计费上界，请改用文本或先完成材料解析。",
  BUDGET_MEDIA_INPUT_INVALID: "媒体内容编码无效，请重新选择材料。",
  BUDGET_MEDIA_INPUT_TOO_LARGE: "媒体内容超过已配置计费上界适用的大小限制，请缩小材料范围。",
};

/** Stored failures are untrusted historical diagnostics, never learner/model text. */
export function tutorFailureForDisplay(status: unknown, storedError: unknown): TutorJobError | null {
  if (status === "cancelled") return { message: TUTOR_CANCELLED_MESSAGE };
  if (status === "outcome_unknown") return { message: TUTOR_UNKNOWN_MESSAGE };
  if (status === "clarify") return { message: PAGE_CITATION_CLARIFY_MESSAGE, code: "page_not_in_sources", nextAction: "clarify" };
  if (status !== "failed") return null;
  const error = storedError && typeof storedError === "object" ? storedError as Record<string, unknown> : null;
  if (error?.code === "page_not_in_sources" && error.nextAction === "clarify") {
    return { message: PAGE_CITATION_CLARIFY_MESSAGE, code: "page_not_in_sources", nextAction: "clarify" };
  }
  const code = typeof error?.code === "string" ? error.code : null;
  return code !== null && Object.hasOwn(knownFailureMessages, code)
    ? { code, message: knownFailureMessages[code]! }
    : { message: TUTOR_FAILURE_MESSAGE };
}
