import { beforeEach, expect, it, vi } from "vitest";
import { admitOpeningAiGradingWorkSource, readOpeningAiGradingContext } from "./opening-ai-grading-context";
const mocks = vi.hoisted(() => ({ qualify: vi.fn(), sources: vi.fn(), photo: vi.fn(), item: vi.fn() }));
vi.mock("./opening-learning-facts", async () => ({
  ...await vi.importActual<typeof import("./opening-learning-facts")>("./opening-learning-facts"),
  lockLearningOwner: async () => {}, admitLearningSources: mocks.sources,
}));
vi.mock("./opening-observation-revision-history", () => ({ qualifyObservationRevision: mocks.qualify }));
vi.mock("./opening-answer-interpretation-state", () => ({ readOpeningAnswerInterpretationMetadata: async () => null }));
const id = "11111111-1111-4111-8111-111111111111", original = "22222222-2222-4222-8222-222222222222", photo = "33333333-3333-4333-8333-333333333333";
const scope = { workspaceId: id, ownerUserId: id };
const tx = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
  const text = parts.join("?");
  if (text === "FOR SHARE") return [];
  if (text.includes("SELECT id FROM users")) return [{ id }];
  if (text.includes("SELECT o.*")) return [{ id, current_head_id: id, grading_work_source: { id: photo, version: 1, physicalPage: 1 }, answer_revision: 1 }];
  if (text.includes("client_key=")) return [];
  if (text.includes("SELECT v.*")) return [mocks.item()];
  if (text.includes("SELECT id,mime")) return mocks.photo();
  if (text.includes("INSERT INTO opening_source_versions")) return [];
  throw new Error(`Unexpected query: ${text}`);
}), { json: (value: unknown) => value });
beforeEach(() => {
  vi.clearAllMocks(); mocks.sources.mockRejectedValue(new Error("original source is unavailable"));
  mocks.qualify.mockResolvedValue({ id, attemptId: id, problemId: id, itemVersionId: id, sessionId: id, sourceIds: [original],
    sourceVersions: { [original]: 2 }, answer: "original answer", eligibility: { usableForCurrentVersion: "no" } });
  mocks.item.mockReturnValue({ id, stem_snapshot: "sealed question", source_id: original, attempt_source_ids: [original] });
  mocks.photo.mockReturnValue([{ id: photo, mime: "image/png", bytes: 100, version: 1 }]);
});
it("seals an owned work photo while retaining captured question versions without resolving missing references", async () => {
  await expect(admitOpeningAiGradingWorkSource(tx as never, scope, id)).resolves.toEqual({ sourceIds: [original, photo].sort(), sourceVersions: { [original]: 2, [photo]: 1 } });
  expect(mocks.sources).not.toHaveBeenCalled();
  expect(tx.mock.calls.some(([parts]) => parts.join("").includes("INSERT INTO opening_source_versions"))).toBe(true);
});
it("keeps normal grading strict when the same question is ineligible", async () => {
  await expect(readOpeningAiGradingContext(tx as never, scope, { observationId: id })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(mocks.photo).not.toHaveBeenCalled();
});
it.each([{ rows: [] }, { rows: [{ id: photo, mime: "image/png", bytes: 100, version: 2 }] }])("rejects unavailable or changed work photos: %j", async ({ rows }) => {
  mocks.photo.mockReturnValue(rows);
  await expect(admitOpeningAiGradingWorkSource(tx as never, scope, id)).rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects using the original question as the work photo before source-version writes", async () => {
  mocks.item.mockReturnValue({ id, stem_snapshot: "sealed question", source_id: photo, attempt_source_ids: [original] });
  await expect(admitOpeningAiGradingWorkSource(tx as never, scope, id)).rejects.toMatchObject({ code: "VALIDATION" });
  expect(mocks.photo).not.toHaveBeenCalled();
});
