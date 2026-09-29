import { describe, expect, it } from "vitest";
import { aiRoleSchema, rolePolicySchema } from "@aistudy/contracts";
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
      expect(rolePolicySchema.parse(policy)).toEqual(policy);
      expect(policy).toBe(ROLE_POLICIES[role]);
      expect(getRolePolicy(role)).toBe(policy);
      expect(policy.role).toBe(role);
      expect(policy.instruction.length).toBeGreaterThan(0);
      expect(policy.allowFormalAssetMutation).toBe(false);
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
});
