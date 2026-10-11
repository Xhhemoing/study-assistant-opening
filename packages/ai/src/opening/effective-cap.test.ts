import { describe, expect, it } from "vitest";
import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  resolveEffectiveDailyCap,
} from "./effective-cap";

describe("resolveEffectiveDailyCap", () => {
  it("uses env when env > 0 and workspace is unset", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 500,
      workspaceCapCents: null,
      confirmed: false,
    })).toEqual({ capCents: 500, source: "env" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 500,
      workspaceCapCents: undefined,
      confirmed: true,
    })).toEqual({ capCents: 500, source: "env" });
  });

  it("takes min(env, workspace) when env > 0 and workspace is set", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 1000,
      workspaceCapCents: 400,
      confirmed: false,
    })).toEqual({ capCents: 400, source: "min" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 300,
      workspaceCapCents: 900,
      confirmed: true,
    })).toEqual({ capCents: 300, source: "min" });
  });

  it("disables when env = 0 and workspace is unset (safe default)", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: null,
      confirmed: false,
    })).toEqual({ capCents: 0, source: "disabled" });
  });

  it("uses min(workspace, ceiling) when env = 0 and owner confirmed", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: 1500,
      confirmed: true,
    })).toEqual({ capCents: 1500, source: "workspace" });
    expect(OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS).toBe(2000);
  });

  it("disables unconfirmed workspace overrides when env = 0", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: 1500,
      confirmed: false,
    })).toEqual({ capCents: 0, source: "disabled" });
  });

  it("truncates workspace overrides over the personal ceiling", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: 5000,
      confirmed: true,
    })).toEqual({ capCents: 2000, source: "workspace" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: 5000,
      confirmed: true,
      ceilingCents: 800,
    })).toEqual({ capCents: 800, source: "workspace" });
  });

  it("disables when pricing is not configured", () => {
    expect(resolveEffectiveDailyCap({
      envCapCents: 500,
      workspaceCapCents: null,
      confirmed: false,
      pricingConfigured: false,
    })).toEqual({ capCents: 0, source: "disabled" });
    expect(resolveEffectiveDailyCap({
      envCapCents: 0,
      workspaceCapCents: 1500,
      confirmed: true,
      pricingConfigured: false,
    })).toEqual({ capCents: 0, source: "disabled" });
  });
});
