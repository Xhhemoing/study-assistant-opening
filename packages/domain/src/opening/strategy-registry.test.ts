import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRATEGY_TEMPLATE_ID,
  getStrategyTemplate,
  listStrategyTemplates,
  resolveStrategyTemplate,
  strategyTemplateSchema,
} from "./strategy-registry";

describe("opening strategy registry", () => {
  it("exposes the only v1 strict-citation template", () => {
    expect(listStrategyTemplates()).toEqual([
      expect.objectContaining({
        id: DEFAULT_STRATEGY_TEMPLATE_ID,
        citationPolicy: "require_page",
      }),
    ]);
  });

  it("falls back explicitly to the default template for legacy and unknown ids", () => {
    expect(resolveStrategyTemplate(null)).toMatchObject({ id: DEFAULT_STRATEGY_TEMPLATE_ID });
    expect(resolveStrategyTemplate(undefined)).toMatchObject({ id: DEFAULT_STRATEGY_TEMPLATE_ID });
    expect(resolveStrategyTemplate("missing-template")).toMatchObject({ id: DEFAULT_STRATEGY_TEMPLATE_ID });
  });

  it("does not permit downgrade policies or mastery keys", () => {
    expect(strategyTemplateSchema.safeParse({
      id: "soft-citation",
      version: "1",
      displayName: "Soft citation",
      citationPolicy: "prefer_page",
      instructionSuffix: "try",
    }).success).toBe(false);
    expect(strategyTemplateSchema.safeParse({
      id: "default-strict-citation",
      version: "1",
      displayName: "Bad template",
      citationPolicy: "require_page",
      instructionSuffix: "answer",
      masteryPercent: 80,
    }).success).toBe(false);
  });

  it("requires an exact known id for direct registry access", () => {
    expect(() => getStrategyTemplate("missing-template")).toThrow(/unknown strategy template/);
  });
});
