import { describe, expect, it } from "vitest";
import {
  buildAiReadinessItems,
  hasAiReadinessHardBlockers,
  isAiReadinessHardBlocker,
} from "./ai-readiness";

const readyFacts = {
  keyedModelCount: 2,
  pricingConfigured: true,
  effectiveCapCents: 500,
  usedCents: 10,
  remainingCents: 490,
  reconciledUnknownCount: 0,
  visionAvailable: true,
  workerOk: true,
  workerDetail: "worker 积压正常",
  availableModelCount: 2,
};

describe("ai readiness classification", () => {
  it("marks vision_model as soft and does not hard-block when only vision is missing", () => {
    const items = buildAiReadinessItems({ ...readyFacts, visionAvailable: false });
    const vision = items.find(item => item.key === "vision_model");
    expect(vision).toMatchObject({ ok: false, severity: "soft" });
    expect(isAiReadinessHardBlocker(vision!)).toBe(false);
    expect(hasAiReadinessHardBlockers(items)).toBe(false);
  });

  it("keeps budget 0 as a hard blocker and does not treat budget-off as soft", () => {
    const items = buildAiReadinessItems({
      ...readyFacts,
      effectiveCapCents: 0,
      remainingCents: 0,
      availableModelCount: 0,
      visionAvailable: false,
    });
    const budget = items.find(item => item.key === "daily_budget");
    const available = items.find(item => item.key === "available_model");
    const vision = items.find(item => item.key === "vision_model");
    expect(budget).toMatchObject({ ok: false, severity: "hard", detail: "日额度未开启（有效额度为 0）" });
    expect(available).toMatchObject({ ok: false, severity: "hard" });
    expect(vision).toMatchObject({ ok: false, severity: "soft" });
    expect(hasAiReadinessHardBlockers(items)).toBe(true);
    expect(items.filter(isAiReadinessHardBlocker).map(item => item.key).sort()).toEqual([
      "available_model",
      "daily_budget",
    ]);
  });

  it("treats reconciled_unknown as soft informational even when counted", () => {
    const items = buildAiReadinessItems({ ...readyFacts, reconciledUnknownCount: 3 });
    const reconciled = items.find(item => item.key === "reconciled_unknown");
    expect(reconciled).toMatchObject({ ok: true, severity: "soft" });
    expect(isAiReadinessHardBlocker(reconciled!)).toBe(false);
  });

  it("falls back to key-based severity when severity field is omitted (legacy clients)", () => {
    expect(isAiReadinessHardBlocker({ key: "vision_model", ok: false })).toBe(false);
    expect(isAiReadinessHardBlocker({ key: "daily_budget", ok: false })).toBe(true);
    expect(isAiReadinessHardBlocker({ key: "available_model", ok: false })).toBe(true);
  });

  it("points fixHints at advanced settings and clarifies vision is optional for text tutor", () => {
    const items = buildAiReadinessItems({
      ...readyFacts,
      visionAvailable: false,
      effectiveCapCents: 0,
      remainingCents: 0,
      availableModelCount: 0,
    });
    const byKey = Object.fromEntries(items.map(item => [item.key, item]));
    expect(byKey.daily_budget.fixHint).toContain("/settings/advanced");
    expect(byKey.daily_budget.fixHint).toContain("开启并确认每日额度");
    expect(byKey.provider_key.fixHint).toContain("/settings/advanced");
    expect(byKey.vision_model.fixHint).toMatch(/文字辅导/);
    expect(byKey.vision_model.fixHint).toContain("/settings/advanced");
    expect(byKey.available_model.fixHint).toContain("日额度 > 0");
  });
});
