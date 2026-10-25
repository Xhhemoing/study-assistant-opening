import type { TutorJobError } from "@aistudy/contracts";
import { PAGE_CITATION_CLARIFY_MESSAGE } from "./tutor-policy";

export const TUTOR_FAILURE_MESSAGE = "这次没有得到回答。可以刷新看看，或者再问一次。";
export const TUTOR_UNKNOWN_MESSAGE = "还不确定这次是否答完，用量也还在确认；为避免重复计费，不会自动再问一次。";
export const TUTOR_CANCELLED_MESSAGE = "已停止这次回答。";
/** No usable tutor model (missing key, removed or unavailable route) — the one fix is in settings. */
export const TUTOR_MODEL_SETUP_MESSAGE = "还没有配置可用的 AI 模型，去设置里配置。";
/** Stored with code TUTOR_JOB_STALE when a queued answer was never picked up (no model call was made). */
export const TUTOR_STALE_MESSAGE = "这次回答一直没开始，已经停下了，没有产生费用。可以再问一次。";

const knownFailureMessages: Readonly<Record<string, string>> = {
  BUDGET_EXCEEDED: "今日 AI 预算已达上限，请在设置中核对预算，或明天再试。",
  REQUEST_CAP_EXCEEDED: "该模型今天的请求次数已达上限；可在设置中为该用途指定备用模型。",
  PARENT_BUDGET_EXCEEDED: "这一问的用量已到上限，已经停下。可以在设置里看看预算。",
  PARENT_BUDGET_CALL_LIMIT: "这一问请求 AI 的次数已到上限，已经停下。",
  PARENT_BUDGET_BLOCKED: "这一问的费用超出预算，已经停下。可以在设置里看看预算。",
  PARENT_BUDGET_OUTCOME_UNKNOWN: TUTOR_UNKNOWN_MESSAGE,
  BUDGET_OUTCOME_UNKNOWN: TUTOR_UNKNOWN_MESSAGE,
  BUDGET_EXECUTION_CLAIMED: TUTOR_UNKNOWN_MESSAGE,
  AI_ROUTE_UNAVAILABLE: TUTOR_MODEL_SETUP_MESSAGE,
  AI_MODEL_UNAVAILABLE: TUTOR_MODEL_SETUP_MESSAGE,
  VISION_INPUT_REQUIRED: "当前模型不能看图，请在设置中选择支持图片的模型",
  PROVIDER_DISABLED: TUTOR_MODEL_SETUP_MESSAGE,
  PROVIDER_AUTH: "AI 服务授权失败，请在设置中核对该服务的密钥。",
  PROVIDER_RATE_LIMIT: "AI 服务当前请求过多，请稍后再试。",
  PROVIDER_MEDIA_UNSUPPORTED: "所选模型无法处理本次材料，请选择支持该材料类型的模型。",
  PROVIDER_PAYLOAD_TOO_LARGE: "本次材料超出模型的输入限制，请缩小材料范围后再试。",
  BUDGET_MEDIA_COST_UNBOUNDED: "当前模型还没设置图片/音频的用量上限，请改用文字提问，或等材料处理完成。",
  BUDGET_MEDIA_INPUT_INVALID: "这份图片或音频读不出来，请重新选择材料。",
  BUDGET_MEDIA_INPUT_TOO_LARGE: "图片或音频太大了，请缩小材料范围。",
  TUTOR_JOB_STALE: TUTOR_STALE_MESSAGE,
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
