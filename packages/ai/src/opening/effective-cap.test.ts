import { describe, expect, it } from "vitest";
import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  resolveEffectiveDailyCap,
} from "./effective-cap";

describe("resolveEffectiveDailyCap", () => {
  it("uses env when env > 0 and workspace is unset", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 500, workspaceCapCents: null, confirmed: false,
    })).toEqual({ capCents: 500, source: "env" });
  });

  it("takes the min of env and workspace when both are set", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 500, workspaceCapCents: 200, confirmed: true,
    })).toEqual({ capCents: 200, source: "min" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 100, workspaceCapCents: 500, confirmed: true,
    })).toEqual({ capCents: 100, source: "min" });
  });

  it("stays disabled when env is 0 and workspace is unset or unconfirmed", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0, workspaceCapCents: null, confirmed: false,
    })).toEqual({ capCents: 0, source: "disabled" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 0, workspaceCapCents: 800, confirmed: false,
    })).toEqual({ capCents: 0, source: "disabled" });
  });

  it("uses the confirmed workspace cap capped by the personal ceiling when env is 0", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0, workspaceCapCents: 800, confirmed: true, pricingConfigured: true,
    })).toEqual({ capCents: 800, source: "workspace" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 0, workspaceCapCents: 5_000, confirmed: true, pricingConfigured: true,
    })).toEqual({ capCents: OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS, source: "workspace" });
  });

  it("stays disabled when pricing is missing under env=0 workspace enablement", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0, workspaceCapCents: 800, confirmed: true, pricingConfigured: false,
    })).toEqual({ capCents: 0, source: "disabled" });
  });

  it("rejects invalid integers", () => {
    expect(() => resolveEffectiveDailyCap({
      envCapCents: 1.5, workspaceCapCents: null, confirmed: false,
    })).toThrow(/invalid env/);
    expect(() => resolveEffectiveDailyCap({
      envCapCents: 0, workspaceCapCents: -1, confirmed: true,
    })).toThrow(/invalid workspace/);
  });
});
