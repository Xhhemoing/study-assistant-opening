import { beforeEach, expect, it, vi } from "vitest";
import { mergeOpeningCatalog } from "@aistudy/ai";
import { DEFAULT_OPENING_AI_SETTINGS, openingAiSettingsSchema } from "@aistudy/contracts";
import { readOpeningAutoGradeSkip } from "../../../../../../packages/database/src/repositories/opening-auto-grade-policy";
import { resolveAutoGradePolicy } from "./auto-grade-policy";

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), cap: vi.fn(), routing: vi.fn(), preferences: vi.fn(), planning: vi.fn() }));
vi.mock("@aistudy/config", () => ({ loadOpeningModelCatalog: mocks.catalog, loadOpeningAutoGradeDailyCap: mocks.cap, loadOpeningEmbeddingConfig: () => null }));
vi.mock("@aistudy/database", () => ({
  createWorkspacePreferencesRepository: () => ({ getLearningPreferences: mocks.preferences }),
  createOpeningPlanningSettingsRepository: () => ({ get: mocks.planning }),
  loadOpeningRouting: mocks.routing,
}));
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const model = { id: "paid", providerId: "fixture", providerLabel: "Fixture", label: "Paid", modelName: "fixture",
  baseUrl: "https://fixture.invalid/v1", apiKey: "non-secret-fixture", supportsVision: false,
  inputCentsPerMillion: 100, outputCentsPerMillion: 100 };
function routing(cap = 100, patch: Partial<typeof model> = {}, fallback: "none" | "free" | "paid" = "none") {
  const settings = openingAiSettingsSchema.parse({ ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes: fallback === "none" ? undefined : {
    "practice.grade-text": { primary: "paid", fallback: "fallback" },
  } });
  const models = [{ ...model, ...patch }, ...(fallback === "none" ? [] : [{ ...model, id: "fallback",
    ...(fallback === "free" ? { billing: "free_tier" as const, dailyRequestCap: 100, inputCentsPerMillion: 0, outputCentsPerMillion: 0 } : {}),
  }])];
  mocks.routing.mockResolvedValue({ settings, merged: mergeOpeningCatalog([], models, { defaultModelId: "paid", dailyCapCents: cap }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.preferences.mockResolvedValue({ autoGradeOnSave: true });
  mocks.planning.mockResolvedValue({ settings: null });
  mocks.catalog.mockReturnValue({ models: [], dailyCapCents: 100 }); mocks.cap.mockReturnValue(50);
  routing();
});
it("treats a malformed catalog as unavailable without exposing its contents", async () => {
  mocks.catalog.mockImplementation(() => { throw new SyntaxError("secret catalog contents"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(resolveAutoGradePolicy({} as never, scope)).resolves.toMatchObject({ enabled: true, modelAvailable: false, dailyCap: 50 });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Opening auto-grade model unavailable", { error: "SyntaxError" });
  } finally { warn.mockRestore(); }
});
it("disables automatic grading when the daily cap is malformed", async () => {
  mocks.cap.mockImplementation(() => { throw new Error("private config"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(resolveAutoGradePolicy({} as never, scope)).resolves.toMatchObject({ modelAvailable: true, dailyCap: 0 });
    expect(warn).toHaveBeenCalledWith("Opening auto-grade daily cap unavailable", { error: "Error" });
  } finally { warn.mockRestore(); }
});
it("propagates preference database read failures", async () => {
  const failure = new Error("database unavailable"); mocks.preferences.mockRejectedValue(failure);
  await expect(resolveAutoGradePolicy({} as never, scope)).rejects.toBe(failure);
});
it("checks the photo task when a sealed photo is present", async () => {
  await expect(resolveAutoGradePolicy({} as never, scope, true)).resolves.toMatchObject({ modelAvailable: false, modelUnavailableReason: "no_model" });
});
it("propagates real routing SQL failures rather than reporting missing models", async () => {
  const failure = Object.assign(new Error("connection closed"), { code: "08006" });
  mocks.routing.mockRejectedValue(failure);
  await expect(resolveAutoGradePolicy({} as never, scope)).rejects.toBe(failure);
});
it.each([
  [0, {}, "none", false, "budget"],
  [0, { apiKey: "" }, "none", false, "no_model"],
  [0, { inputCentsPerMillion: 0 }, "none", false, "no_model"],
  [0, { apiKey: "" }, "paid", false, "budget"],
  [0, {}, "free", true, null],
] as const)("uses real merged routing at cap %s with %j fallback %s", async (cap, patch, fallback, available, reason) => {
  routing(cap, patch, fallback);
  const policy = await resolveAutoGradePolicy({} as never, scope);
  expect(policy.modelAvailable).toBe(available);
  if (reason) {
    expect(policy.modelUnavailableReason).toBe(reason);
    const sql = vi.fn().mockResolvedValue([{ auto_grade_on_save: true }]);
    expect(await readOpeningAutoGradeSkip(sql as never, scope, policy)).toBe(reason);
    expect(sql).toHaveBeenCalledTimes(1);
  } else {
    expect(policy.primaryModel).toBeNull();
    expect(policy.fallbackModel?.billing).toBe("free_tier");
  }
});
it("does not use an unrelated budget-disabled model to explain a missing selected model", async () => {
  const merged = mergeOpeningCatalog([], [model], { defaultModelId: "paid", dailyCapCents: 0 });
  mocks.routing.mockResolvedValue({ settings: openingAiSettingsSchema.parse({ ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "removed" }), merged });
  await expect(resolveAutoGradePolicy({} as never, scope)).resolves.toMatchObject({ modelAvailable: false, modelUnavailableReason: "no_model" });
});
it("uses configured Luna for a sealed photo while text keeps the ordinary default", async () => {
  const luna = { ...model, id: "luna", modelName: "gpt-6-luna", supportsVision: true,
    mediaInputTokenUpperBound: 3000, mediaMaxInputBytes: 100000, mediaInputCentsPerMillion: 100 };
  mocks.routing.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS,
    merged: mergeOpeningCatalog([], [model, luna], { defaultModelId: "paid", dailyCapCents: 100 }) });
  await expect(resolveAutoGradePolicy({} as never, scope, true)).resolves.toMatchObject({
    modelAvailable: true, primaryModel: { supportsVision: true, modelSnapshot: { id: "luna", modelName: "gpt-6-luna" } },
  });
  await expect(resolveAutoGradePolicy({} as never, scope)).resolves.toMatchObject({
    modelAvailable: true, primaryModel: { supportsVision: false, modelSnapshot: { id: "paid", modelName: "fixture" } },
  });
});
