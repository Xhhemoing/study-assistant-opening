import { expect, it } from "vitest";
import { openingOnboardingInputSchema, openingPlanningSettingsSchema } from "@aistudy/contracts";
import { buildOpeningOnboardingSeed } from "./onboarding";
const input = { action: "complete" as const, clientKey: "onboard-test-01", subject: "积分学", scenario: "final" as const,
  examDate: null, timeZone: "Asia/Shanghai", sourceIds: [] };
it("seeds a valid three-action learning loop without inventing mastery or deadlines", () => {
  const result = buildOpeningOnboardingSeed(input, new Date("2026-10-14T00:00:00Z"));
  expect(openingPlanningSettingsSchema.safeParse(result.settings).success).toBe(true);
  expect(result.settings.weekOneMonday).toBe("2026-10-12");
  expect(result.tasks).toHaveLength(3);
  expect(result.tasks.every(t => t.title.includes("积分学"))).toBe(true);
  expect(result.tasks[0]!.title).toContain("独立");
  expect(result.tasks[2]!.title).toContain("变式");
  expect(result.goal.status).toBe("unobserved");
  expect(result.tasks.every(t => !("dueAt" in t))).toBe(true);
});
it("uses workspace-local day rather than the server UTC day", () => {
  const now = new Date("2026-10-12T01:00:00Z");
  expect(buildOpeningOnboardingSeed({ ...input, timeZone: "America/Los_Angeles" }, now).settings.weekOneMonday).toBe("2026-10-05");
  expect(buildOpeningOnboardingSeed(input, now).settings.weekOneMonday).toBe("2026-10-12");
});
it("rejects invalid timezone and an already-passed exam date", () => {
  expect(() => buildOpeningOnboardingSeed({ ...input, timeZone: "bad/tz" })).toThrow();
  expect(() => buildOpeningOnboardingSeed({ ...input, examDate: "2026-10-13" }, new Date("2026-10-14T01:00:00Z"))).toThrow();
});
it.each(["2026-02-30", "2026-13-01", "2026-00-10"])("rejects non-calendar date %s before persistence", examDate => {
  expect(openingOnboardingInputSchema.safeParse({ ...input, examDate }).success).toBe(false);
});
it("rejects scope, fake evidence, duplicate sources and blank subject", () => {
  for (const patch of [{ workspaceId: "attacker" }, { mastered: true }, { subject: "  " },
    { sourceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }]) {
    expect(openingOnboardingInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  }
});
it("allows material-first skip without an AI configuration or invented goal", () => {
  expect(openingOnboardingInputSchema.parse({ action: "skip", clientKey: "skip-onboard-01" })).toEqual({ action: "skip", clientKey: "skip-onboard-01" });
});
