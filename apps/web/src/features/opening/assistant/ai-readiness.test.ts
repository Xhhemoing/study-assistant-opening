import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: unknown; href: string }) =>
    createElement("a", { ...props, href }, children),
}));

import { AiReadinessChecklistView, isAiReadinessChecklistHardBlocker } from "./ai-readiness";
import {
  BUDGET_CONFIRM_CTA,
  BUDGET_CONFIRM_HREF,
  BUDGET_CONFIRM_LEAD,
  isBudgetRelatedHardBlocker,
  needsBudgetConfirmCta,
  type AiReadinessChecklistItem,
} from "./ai-readiness-model";

const hardBudgetFail: AiReadinessChecklistItem = {
  key: "daily_budget",
  ok: false,
  detail: "日额度未开启（有效额度为 0）",
  fixHint: "在高级设置开启并确认每日额度",
  severity: "hard",
};

const hardAvailableFail: AiReadinessChecklistItem = {
  key: "available_model",
  ok: false,
  detail: "当前没有可用模型",
  fixHint: "到高级设置开启并确认每日额度",
  severity: "hard",
};

const softOcrFail: AiReadinessChecklistItem = {
  key: "parser_ocr",
  ok: false,
  detail: "扫描件 OCR 未配置",
  fixHint: "PARSER_OCR_MODEL_DIR",
  severity: "soft",
};

const softVisionFail: AiReadinessChecklistItem = {
  key: "vision_model",
  ok: false,
  detail: "没有支持图片的可用模型",
  fixHint: "配置视觉模型",
  severity: "soft",
};

const hardProviderFail: AiReadinessChecklistItem = {
  key: "provider_key",
  ok: false,
  detail: "没有已配置密钥的模型",
  fixHint: "配置密钥",
  severity: "hard",
};

describe("AiReadinessChecklist hard-blocker filter", () => {
  it("does not treat missing vision as a hard blocker", () => {
    expect(isAiReadinessChecklistHardBlocker({
      key: "vision_model", ok: false, detail: "x", fixHint: "y", severity: "soft",
    })).toBe(false);
    expect(isAiReadinessChecklistHardBlocker({
      key: "vision_model", ok: false, detail: "x", fixHint: "y",
    })).toBe(false);
  });

  it("does not treat reconciled_unknown as a hard blocker", () => {
    expect(isAiReadinessChecklistHardBlocker({
      key: "reconciled_unknown", ok: false, detail: "x", fixHint: "y",
    })).toBe(false);
  });

  it("does not treat missing parser_ocr as a hard blocker", () => {
    expect(isAiReadinessChecklistHardBlocker({
      key: "parser_ocr", ok: false, detail: "扫描件 OCR 未配置", fixHint: "y", severity: "soft",
    })).toBe(false);
    expect(isAiReadinessChecklistHardBlocker({
      key: "parser_ocr", ok: false, detail: "扫描件 OCR 未配置", fixHint: "y",
    })).toBe(false);
  });

  it("keeps budget-off and no-available-model as hard blockers", () => {
    expect(isAiReadinessChecklistHardBlocker(hardBudgetFail)).toBe(true);
    expect(isAiReadinessChecklistHardBlocker(hardAvailableFail)).toBe(true);
  });

  it("ignores vision when deciding whether the blocking banner should open", () => {
    const onlyVisionAndReconcile = [
      { key: "provider_key", ok: true, detail: "", fixHint: "", severity: "hard" as const },
      { key: "daily_budget", ok: true, detail: "", fixHint: "", severity: "hard" as const },
      softVisionFail,
      { key: "reconciled_unknown", ok: true, detail: "", fixHint: "", severity: "soft" as const },
      { key: "available_model", ok: true, detail: "", fixHint: "", severity: "hard" as const },
      softOcrFail,
    ];
    expect(onlyVisionAndReconcile.some(isAiReadinessChecklistHardBlocker)).toBe(false);
    expect(needsBudgetConfirmCta(onlyVisionAndReconcile)).toBe(false);
  });
});

describe("AiReadinessChecklist vision tip policy", () => {
  it("keeps vision soft so default UI can omit the tip without hard-blocking", () => {
    expect(isAiReadinessChecklistHardBlocker(softVisionFail)).toBe(false);
  });
});

describe("G18 budget confirm CTA helpers", () => {
  it("flags daily_budget and available_model hard fails as budget-related", () => {
    expect(isBudgetRelatedHardBlocker(hardBudgetFail)).toBe(true);
    expect(isBudgetRelatedHardBlocker(hardAvailableFail)).toBe(true);
    expect(isBudgetRelatedHardBlocker(hardProviderFail)).toBe(false);
    expect(isBudgetRelatedHardBlocker(softOcrFail)).toBe(false);
  });

  it("needs budget CTA when hard-blocked by daily_budget", () => {
    expect(needsBudgetConfirmCta([hardBudgetFail, softOcrFail])).toBe(true);
  });

  it("needs budget CTA when hard-blocked by available_model alone", () => {
    expect(needsBudgetConfirmCta([
      { key: "daily_budget", ok: true, detail: "", fixHint: "", severity: "hard" },
      hardAvailableFail,
    ])).toBe(true);
  });

  it("does not need budget CTA for provider-only hard fail", () => {
    expect(needsBudgetConfirmCta([hardProviderFail, softOcrFail])).toBe(false);
  });

  it("does not need budget CTA when only soft OCR/vision fail", () => {
    expect(needsBudgetConfirmCta([softOcrFail, softVisionFail])).toBe(false);
  });
});

describe("G18 AiReadinessChecklistView budget banner", () => {
  it("surfaces lead copy and primary CTA to #daily-budget when daily_budget hard-fails", () => {
    const html = renderToStaticMarkup(createElement(AiReadinessChecklistView, {
      items: [hardBudgetFail, hardAvailableFail, softOcrFail],
    }));
    expect(html).toContain(BUDGET_CONFIRM_LEAD);
    expect(html).toContain(BUDGET_CONFIRM_CTA);
    expect(html).toContain(`href="${BUDGET_CONFIRM_HREF}"`);
    expect(html).toContain('data-testid="ai-readiness-budget-banner"');
    expect(html).toContain('data-testid="ai-readiness-budget-cta"');
    expect(html).toContain('data-budget-confirm="needed"');
    expect(html).toContain("AI 为何还不可用");
    // Soft OCR must not appear in the hard checklist list (filtered out).
    expect(html).not.toContain("扫描件 OCR 未配置");
  });

  it("surfaces budget CTA when only available_model hard-fails", () => {
    const html = renderToStaticMarkup(createElement(AiReadinessChecklistView, {
      items: [hardAvailableFail],
    }));
    expect(html).toContain(BUDGET_CONFIRM_LEAD);
    expect(html).toContain(`href="${BUDGET_CONFIRM_HREF}"`);
  });

  it("does not show budget banner for provider-only hard fail", () => {
    const html = renderToStaticMarkup(createElement(AiReadinessChecklistView, {
      items: [hardProviderFail],
    }));
    expect(html).toContain("AI 为何还不可用");
    expect(html).toContain('data-budget-confirm="not-needed"');
    expect(html).not.toContain('data-testid="ai-readiness-budget-banner"');
    expect(html).not.toContain(BUDGET_CONFIRM_LEAD);
    expect(html).toContain('href="/settings/advanced"');
  });

  it("renders nothing when only soft parser_ocr fails (never hard-blocks)", () => {
    const html = renderToStaticMarkup(createElement(AiReadinessChecklistView, {
      items: [softOcrFail],
    }));
    expect(html).toBe("");
  });
});
