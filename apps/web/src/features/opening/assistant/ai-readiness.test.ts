import { describe, expect, it } from "vitest";
import { isAiReadinessChecklistHardBlocker } from "./ai-readiness";

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

  it("keeps budget-off and no-available-model as hard blockers", () => {
    expect(isAiReadinessChecklistHardBlocker({
      key: "daily_budget", ok: false, detail: "日额度未开启（有效额度为 0）", fixHint: "y", severity: "hard",
    })).toBe(true);
    expect(isAiReadinessChecklistHardBlocker({
      key: "available_model", ok: false, detail: "当前没有可用模型", fixHint: "y", severity: "hard",
    })).toBe(true);
  });

  it("ignores vision when deciding whether the blocking banner should open", () => {
    const onlyVisionAndReconcile = [
      { key: "provider_key", ok: true, detail: "", fixHint: "", severity: "hard" as const },
      { key: "daily_budget", ok: true, detail: "", fixHint: "", severity: "hard" as const },
      { key: "vision_model", ok: false, detail: "没有支持图片的可用模型", fixHint: "y", severity: "soft" as const },
      { key: "reconciled_unknown", ok: true, detail: "", fixHint: "", severity: "soft" as const },
      { key: "available_model", ok: true, detail: "", fixHint: "", severity: "hard" as const },
    ];
    expect(onlyVisionAndReconcile.some(isAiReadinessChecklistHardBlocker)).toBe(false);
  });
});

describe("AiReadinessChecklist vision tip policy", () => {
  it("keeps vision soft so default UI can omit the tip without hard-blocking", () => {
    // Hard-blocker filter is the gate; soft vision must never reopen the blocking banner.
    expect(isAiReadinessChecklistHardBlocker({
      key: "vision_model", ok: false, detail: "没有支持图片的可用模型", fixHint: "配置视觉模型", severity: "soft",
    })).toBe(false);
  });
});

