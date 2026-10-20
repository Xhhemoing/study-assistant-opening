import type { LearningObservation, Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { evaluateEvidenceEligibility, type EvidenceObservation } from "@aistudy/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { deliver, generate, release } = vi.hoisted(() => ({ deliver: vi.fn(), generate: vi.fn(), release: vi.fn() }));
vi.mock("./opening-study-exposure", () => ({ createOpeningStudyExposureRepository: () => ({ deliver }), generateOpeningStudyExposure: generate, releaseOpeningStudyExposure: release, mapOpeningStudyExposure: (row: Record<string, unknown>) => ({ id: row.id }) }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(), lockWorkspaceLearningHistory: vi.fn() }));
import { createOpeningContentDeliveryRepository } from "./opening-content-delivery";
const scope: Scope = { workspaceId: "10000000-0000-4000-8000-000000000001", ownerUserId: "10000000-0000-4000-8000-000000000002" };
const sourceId = "10000000-0000-4000-8000-000000000003";
const id = "10000000-0000-4000-8000-000000000004";
const sqlReturning = (rows: Record<string, unknown>[], open: Record<string, unknown>[] = [], existing: Record<string, unknown>[] = []): Sql => {
  const query = vi.fn((parts: TemplateStringsArray) => Promise.resolve(parts.join(" ").includes("opening_help_exposures") ? existing : parts.join(" ").includes("opening_learning_attempts") ? open : rows));
  return Object.assign(query, { begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(query) }) as unknown as Sql;
};
beforeEach(() => { vi.clearAllMocks(); deliver.mockResolvedValue({ id, releasedAt: "2026-10-19T00:00:00Z" }); generate.mockResolvedValue({ id }); release.mockResolvedValue({ id, releasedAt: "2026-10-19T00:00:00Z" }); });
describe("authorized content delivery policies", () => {
  it("releases the actual old material version/page without choosing the newest version", async () => {
    const repo = createOpeningContentDeliveryRepository(sqlReturning([]));
    await repo.source(scope, "request-key", { sourceId, version: 2, page: 7 });
    expect(deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ releaseKey: "request-key:material_excerpt:0", contextAnchor: { purpose: "material_read", sourceId, sourceVersion: 2, page: 7 }, origin: "material_excerpt", kind: "hint", supportDomain: "unknown", originReference: { type: "source", id: sourceId, version: "2" } }));
  });
  it("preserves each frozen note provenance version and exact editor revision", async () => {
    const repo = createOpeningContentDeliveryRepository(sqlReturning([{ id, provenance_id: id, context_source_refs: [{ sourceId, sourceVersion: 1 }] }]));
    await repo.note(scope, "request-key", { id, currentRevisionNumber: 3 });
    expect(deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ contextAnchor: { purpose: "note_read", sourceId, sourceVersion: 1 }, originReference: { type: "note", id, version: "3" } }));
  });
  it("records unknown note lineage without inventing a course or current material version", async () => {
    const repo = createOpeningContentDeliveryRepository(sqlReturning([{ id, provenance_id: null }]));
    await repo.note(scope, "request-key", { id, currentRevisionNumber: 3 });
    expect(generate).toHaveBeenCalledWith(expect.anything(), scope, expect.objectContaining({ contextAnchor: { purpose: "note_read" }, supportDomain: "unknown" }));
    expect(deliver).not.toHaveBeenCalled();
  });
  it("targets only the open-at-release attempt snapshot for unassociated note support", async () => {
    const repo = createOpeningContentDeliveryRepository(sqlReturning([{ id, provenance_id: null }], [{ id: sourceId }]));
    await repo.note(scope, "request-key", { id, currentRevisionNumber: 3 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(2, expect.anything(), scope, expect.objectContaining({ contextAnchor: { purpose: "note_read", attemptId: sourceId }, originReference: { type: "note", id, version: "3", possibleOpenAttemptOnly: true }, supportDomain: "unknown" }));
  });
  it("replays the original generic-note target set without adding later attempts", async () => {
    const existing = [{ id, release_intent: { originReference: { type: "note", id, version: "3" } } }];
    const repo = createOpeningContentDeliveryRepository(sqlReturning([{ id, provenance_id: null }], [{ id: sourceId }], existing));
    expect(await repo.note(scope, "request-key", { id, currentRevisionNumber: 3 })).toEqual([{ id }]);
    expect(generate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it("does not send a note whose authorized revision is no longer available", async () => {
    await expect(createOpeningContentDeliveryRepository(sqlReturning([])).note(scope, "request-key", { id, currentRevisionNumber: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deliver).not.toHaveBeenCalled();
  });
  it("treats actual card backs as answer exposure and refuses concurrent version changes", async () => {
    const repo = createOpeningContentDeliveryRepository(sqlReturning([{ id, content_version: 2, source_ids: [sourceId], skill_label: "span", context_source_refs: null }]));
    await repo.cards(scope, "request-key", [{ id, contentVersion: 2 }]);
    expect(deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ origin: "card_answer", level: "revealed", kind: "solution", contextAnchor: { purpose: "card_answer" }, originReference: { type: "card", id, version: "2", sourceRefs: [{ sourceId, sourceVersion: null }], skillLabel: "span" } }));
    deliver.mockClear();
    await expect(repo.cards(scope, "request-key", [{ id, contentVersion: 1 }])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deliver).not.toHaveBeenCalled();
  });
  it("awaits durable release failure instead of reporting successful content delivery", async () => {
    deliver.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(createOpeningContentDeliveryRepository(sqlReturning([])).source(scope, "request-key", { sourceId, version: 1, page: null })).rejects.toThrow("database unavailable");
  });
  it("narrows exact-source reading to unknown support rather than silently granting independence", async () => {
    await createOpeningContentDeliveryRepository(sqlReturning([])).source(scope, "request-key", { sourceId, version: 1, page: 2 });
    const policy = deliver.mock.calls[0]![1];
    const observation: EvidenceObservation = { courseId: id, attemptId: "attempt", problemId: "problem", itemVersionId: "item", startedAt: 100, submittedAt: 300, assistance: "independent", outcome: "correct", verdictSource: "self_report" };
    const context = { helpHistory: { complete: true, exposures: [{ attemptId: null, problemId: null, kind: policy.kind, level: policy.level, supportDomain: policy.supportDomain, delivered: true, deliveredAt: 200 }] } };
    expect(evaluateEvidenceEligibility(observation, context).independentAttempt).toBe("unknown");
    expect(evaluateEvidenceEligibility(observation, context).reasonCodes).toContain("help_association_unknown");
    // The source matcher omits unrelated pages/items instead of attaching generic
    // reading to every attempt in the workspace.
    expect(evaluateEvidenceEligibility(observation, { helpHistory: { complete: true, exposures: [] } }).independentAttempt).toBe("yes");
  });
  it("does not pretend an old student's answer is a reference solution", async () => {
    const repo = createOpeningContentDeliveryRepository(sqlReturning([{ id }]));
    const observation = { id, courseId: id, itemVersionId: sourceId, attemptId: id, historyRevision: 3, sourceIds: [sourceId], skillLabel: "span" } as LearningObservation;
    await repo.history(scope, "request-key", [observation, observation, { ...observation, id: sourceId }]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ origin: "history_solution", kind: "hint", level: "hinted", contextAnchor: { purpose: "history_solution", itemVersionId: sourceId } }));
  });
});
