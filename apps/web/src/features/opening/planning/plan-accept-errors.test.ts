import { describe, expect, it } from "vitest";
import { OpeningApiError } from "../client/api";
import { planAcceptFailure } from "./plan-accept-errors";

describe("planAcceptFailure", () => {
  it.each([
    ["stale_version", "计划已在别处更新，请重新读取后再确认。", true],
    ["task_changed", "有任务已完成或被修改，请重新确认。", false],
    ["source_unavailable", "相关材料暂不可用，请刷新草案后重新选择。", false],
    ["slot_expired", "部分时段已过，请重新安排。", false],
    ["selection_mismatch", "请刷新后重新选择。", false],
  ] as const)("explains %s without inventing a completed recovery", (reason, message, reread) => {
    expect(planAcceptFailure(new OpeningApiError(409, "server detail", "CONFLICT", reason))).toEqual({ message, reread });
    expect(message).not.toMatch(/已为你刷新|已移除/);
  });

  it.each([null, "new-server-reason"])("keeps the existing generic conflict for %s", (reason) => {
    expect(planAcceptFailure(new OpeningApiError(409, "server detail", "CONFLICT", reason))).toEqual({
      message: "计划已变化，请重新读取后再确认；没有重复提交。", reread: false,
    });
  });

  it("does not interpret a reason outside a plan-accept conflict", () => {
    expect(planAcceptFailure(new OpeningApiError(503, "服务暂时不可用", "UNAVAILABLE", "stale_version")))
      .toEqual({ message: "服务暂时不可用", reread: false });
    expect(planAcceptFailure(new TypeError("network lost"))).toEqual({ message: "network lost", reread: false });
    expect(planAcceptFailure(null)).toEqual({ message: "确认推荐草案失败", reread: false });
  });
});
