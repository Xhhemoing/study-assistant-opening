import { beforeEach, expect, it, vi } from "vitest";
import { checkOpeningAutoGradeBudget, type OpeningAutoGradePolicy } from "./opening-auto-grade-policy";
const check = vi.hoisted(() => vi.fn());
vi.mock("./opening-budget", () => ({ checkOpeningBudgetAvailable: check }));
const scope = { workspaceId: "w", ownerUserId: "u" };
const snapshot = { id: "luna", providerId: "fixture", modelName: "gpt-6-luna", inputCentsPerMillion: 100,
  outputCentsPerMillion: 100, mediaInputTokenUpperBound: 10000, mediaMaxInputBytes: 4200000, mediaInputCentsPerMillion: 100 };
const policy: OpeningAutoGradePolicy = { enabled: true, modelAvailable: true, dailyCap: 50, dayStart: new Date(0), dayEnd: new Date(),
  primaryModel: { modelSnapshot: snapshot, inputCentsPerMillion: 100, outputCentsPerMillion: 100, supportsVision: true } };
const context = { question: "read image", answer: "typed answer", referenceText: "visible reference" };
beforeEach(() => { check.mockReset(); check.mockResolvedValue({ allowed: true }); });
it("includes visual reference pages when estimating a text answer", async () => {
  await checkOpeningAutoGradeBudget({} as never, scope, policy, { ...context,
    referenceSources: [{ mime: "image/png", bytes: 100 }] });
  const amountWithImage = check.mock.calls[0]![2].amountCents;
  await checkOpeningAutoGradeBudget({} as never, scope, policy, context);
  expect(amountWithImage).toBeGreaterThan(check.mock.calls[1]![2].amountCents);
});
it("admits PDF pages using the renderer bound and combines all image bytes", async () => {
  const references = [{ mime: "application/pdf", bytes: 50000000 }, { mime: "application/pdf", bytes: 50000000 }];
  await expect(checkOpeningAutoGradeBudget({} as never, scope, policy, { ...context, referenceSources: references })).resolves.toEqual({ allowed: true });
  check.mockClear();
  await expect(checkOpeningAutoGradeBudget({} as never, scope, policy, { ...context, referenceSources: references,
    workSource: { mime: "image/png", bytes: 1 } })).resolves.toEqual({ allowed: false, reason: "budget_unavailable" });
  expect(check).not.toHaveBeenCalled();
});
it("refuses text-only or unbounded models for visual references without reserving", async () => {
  for (const primaryModel of [{ ...policy.primaryModel!, supportsVision: false }, { ...policy.primaryModel!, supportsVision: undefined },
    { ...policy.primaryModel!, modelSnapshot: { ...snapshot, mediaMaxInputBytes: undefined } }]) {
    await expect(checkOpeningAutoGradeBudget({} as never, scope, { ...policy, primaryModel }, { ...context,
      referenceSources: [{ mime: "image/png", bytes: 100 }] })).resolves.toEqual({ allowed: false, reason: "budget_unavailable" });
  }
  expect(check).not.toHaveBeenCalled();
});
it("allows three reference pages plus one work page but refuses a fifth image", async () => {
  const referenceSources = Array.from({ length: 3 }, () => ({ mime: "image/png", bytes: 100 }));
  await expect(checkOpeningAutoGradeBudget({} as never, scope, policy, { ...context, referenceSources,
    workSource: { mime: "image/png", bytes: 100 } })).resolves.toEqual({ allowed: true });
  check.mockClear();
  await expect(checkOpeningAutoGradeBudget({} as never, scope, policy, { ...context, referenceSources: [...referenceSources, referenceSources[0]!] })).resolves.toEqual({ allowed: false, reason: "budget_unavailable" });
  await expect(checkOpeningAutoGradeBudget({} as never, scope, policy, { ...context, referenceSources: [...referenceSources, ...referenceSources] })).resolves.toEqual({ allowed: false, reason: "budget_unavailable" });
  expect(check).not.toHaveBeenCalled();
});
