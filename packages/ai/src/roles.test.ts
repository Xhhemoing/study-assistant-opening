import { describe, expect, it } from "vitest";
import { aiRoleSchema } from "@aistudy/contracts";
import { getRolePolicy, ROLE_POLICIES } from "./roles";

const roles = ["retriever", "explainer", "tutor", "challenger", "editor", "examiner", "collaborator", "silent"] as const;

describe("AI role policies", () => {
  it("defines exactly the supported roles", () => {
    expect(Object.keys(ROLE_POLICIES).sort()).toEqual([...roles].sort());
    expect(aiRoleSchema.options).toEqual(roles);
  });

  it("keeps every role candidate-only and explicitly governed", () => {
    for (const role of roles) {
      const policy = getRolePolicy(role);
      expect(policy.role).toBe(role);
      expect(policy.instruction.length).toBeGreaterThan(0);
      expect(policy.allowFormalAssetMutation).toBe(false);
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
});
