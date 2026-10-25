import { describe, expect, it } from "vitest";
import { OpeningApiError } from "../client/api";
import { formatTurnError, pageForSubmit } from "./turn-errors";

describe("turn-errors (T03 联调)", () => {
  it("explains page_not_in_sources 422", () => {
    expect(
      formatTurnError(new OpeningApiError(422, "page_not_in_sources", "page_not_in_sources")),
    ).toContain("清空页码");
  });

  it("omits empty page for submit", () => {
    expect(pageForSubmit("")).toBeUndefined();
    expect(pageForSubmit("2")).toBe(2);
  });
});

describe("formatTurnError learner copy", () => {
  it("never shows the server's English provider placeholder", () => {
    expect(formatTurnError(new OpeningApiError(503, "provider request failed", "PROVIDER_UNAVAILABLE"))).toBe("AI 服务暂时没有响应，请稍后再试。");
  });
  it("keeps localized server messages and hides English or transport text", () => {
    expect(formatTurnError(new OpeningApiError(409, "所选模型暂不可用", "AI_ROUTE_UNAVAILABLE"))).toBe("所选模型暂不可用");
    expect(formatTurnError(new OpeningApiError(400, "Invalid request body", "VALIDATION"))).toBe("发送失败，请重试。");
    expect(formatTurnError(new TypeError("Failed to fetch"))).toBe("发送失败，请重试。");
  });
});

describe("formatTurnError when no model can answer", () => {
  it.each(["AI_MODEL_UNAVAILABLE", "PROVIDER_DISABLED"])("sends %s to settings with one plain sentence", code => {
    expect(formatTurnError(new OpeningApiError(409, "所选模型暂不可用，请检查设置中的密钥、价格和预算状态；不会自动切换供应商。", code)))
      .toBe("还没有配置可用的 AI 模型，去设置里配置。");
  });
});
