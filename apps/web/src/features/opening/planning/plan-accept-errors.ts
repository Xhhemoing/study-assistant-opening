import { OpeningApiError } from "../client/api";
import { userFacingMessage } from "../../../lib/user-facing-error";

/** Describe the failure without claiming a refresh or removal has already happened. */
export function planAcceptFailure(reason: unknown): { message: string; reread: boolean } {
  if (reason instanceof OpeningApiError && reason.status === 409) {
    if (reason.code === "CONFLICT") {
      switch (reason.reason) {
        case "stale_version":
          return { message: "计划已在别处更新，请重新读取后再确认。", reread: true };
        case "task_changed":
          return { message: "有任务已完成或被修改，请重新确认。", reread: false };
        case "source_unavailable":
          return { message: "相关材料暂不可用，请刷新草案后重新选择。", reread: false };
        case "slot_expired":
          return { message: "部分时段已过，请重新安排。", reread: false };
        case "selection_mismatch":
          return { message: "请刷新后重新选择。", reread: false };
      }
    }
    return { message: "计划已变化，请重新读取后再确认；没有重复提交。", reread: false };
  }
  return { message: userFacingMessage(reason, "确认推荐草案失败"), reread: false };
}
