import type { LearningObservation } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningContentDeliveryRepository } from "./opening-content-delivery";

const hooks = vi.hoisted(() => ({ deliver: vi.fn(), generate: vi.fn(), release: vi.fn(), lock: vi.fn() }));
vi.mock("./opening-study-exposure", () => ({ createOpeningStudyExposureRepository: () => ({ deliver: hooks.deliver }),
  generateOpeningStudyExposure: hooks.generate, releaseOpeningStudyExposure: hooks.release,
  mapOpeningStudyExposure: (row: Record<string, unknown>) => ({ id: row.id }) }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(), lockWorkspaceLearningHistory: hooks.lock }));
const id = "30000000-0000-4000-8000-000000000001", second = "30000000-0000-4000-8000-000000000002";
const source = "30000000-0000-4000-8000-000000000003", otherSource = "30000000-0000-4000-8000-000000000004";
const scope = { workspaceId: id, ownerUserId: second };
const card = (cardId = id, extra: Record<string, unknown> = {}) => ({ id: cardId, content_version: 3, source_ids: [source, otherSource],
  skill_label: "fractions", context_source_refs: [{ sourceId: source, sourceVersion: 1 }], ...extra });
function db(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue(rows);
  return query as unknown as Sql;
}
beforeEach(() => { vi.clearAllMocks(); hooks.deliver.mockImplementation(async (_scope, input) => ({ id: input.releaseKey })); });

describe("card receipt source lineage is frozen per answer, not current material", () => {
  it("preserves multiple versions of one source and unknown supplemental lineage without substituting current versions", async () => {
    const refs = [{ sourceId: source, sourceVersion: 0 }, { sourceId: source, sourceVersion: 2 }, { sourceId: source, sourceVersion: 0 }];
    await createOpeningContentDeliveryRepository(db([card(id, { context_source_refs: refs })])).cards(scope, "card-batch", [{ id, contentVersion: 3 }]);
    const expectedRefs = [{ sourceId: source, sourceVersion: 0 }, { sourceId: source, sourceVersion: 2 }, { sourceId: otherSource, sourceVersion: null }];
    expect(hooks.deliver.mock.calls.map(c => c[1])).toEqual([0, 2].map((sourceVersion, index) => ({
      releaseKey: `card-batch:card_answer:${index}`, contextAnchor: { purpose: "card_answer", sourceId: source, sourceVersion },
      origin: "card_answer", originReference: { type: "card", id, version: "3", sourceRefs: expectedRefs, skillLabel: "fractions" },
      kind: "solution", level: "revealed", supportDomain: "unknown",
    })));
  });
  it.each([
    { label: "null", refs: null }, { label: "boolean", refs: true },
    { label: "partly malformed", refs: [{ sourceId: source, sourceVersion: 1 }, { sourceId: otherSource, sourceVersion: true }] },
  ])("$label stored provenance keeps all versions unknown instead of partially trusting it", async ({ refs }) => {
    await createOpeningContentDeliveryRepository(db([card(id, { context_source_refs: refs })])).cards(scope, "unknown-card", [{ id, contentVersion: 3 }]);
    expect(hooks.deliver).toHaveBeenCalledExactlyOnceWith(scope, {
      releaseKey: "unknown-card:card_answer:0", contextAnchor: { purpose: "card_answer" }, origin: "card_answer",
      originReference: { type: "card", id, version: "3", sourceRefs: [{ sourceId: source, sourceVersion: null }, { sourceId: otherSource, sourceVersion: null }], skillLabel: "fractions" },
      kind: "solution", level: "revealed", supportDomain: "unknown",
    });
  });
  it("keys receipts by caller card order rather than sorted SQL row order", async () => {
    await createOpeningContentDeliveryRepository(db([card(), card(second)])).cards(scope, "ordered", [{ id: second, contentVersion: 3 }, { id, contentVersion: 3 }]);
    expect(hooks.deliver.mock.calls.map(c => [c[1].releaseKey, c[1].originReference.id])).toEqual([
      ["ordered:card_answer:0", second], ["ordered:card_answer:1", id],
    ]);
  });
  it.each(["missing", "changed"] as const)("validates the complete card set before any delivery when the later card is %s", async mode => {
    const rows = mode === "missing" ? [card()] : [card(), card(second, { content_version: 4 })];
    await expect(createOpeningContentDeliveryRepository(db(rows)).cards(scope, "preflight", [{ id, contentVersion: 3 }, { id: second, contentVersion: 3 }]))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(hooks.deliver).not.toHaveBeenCalled();
  });
  it("does not query or create receipts for an empty authorized card list", async () => {
    const query = vi.fn();
    expect(await createOpeningContentDeliveryRepository(query as unknown as Sql).cards(scope, "empty", [])).toEqual([]);
    expect(query).not.toHaveBeenCalled(); expect(hooks.deliver).not.toHaveBeenCalled();
  });
  it("awaits each emitted receipt, stops on a failed delivery, and does not claim rollback of earlier receipts", async () => {
    const failure = new Error("synthetic second release failure");
    hooks.deliver.mockResolvedValueOnce({ id }).mockRejectedValueOnce(failure);
    await expect(createOpeningContentDeliveryRepository(db([card(), card(second)])).cards(scope, "failure", [{ id, contentVersion: 3 }, { id: second, contentVersion: 3 }])).rejects.toBe(failure);
    expect(hooks.deliver).toHaveBeenCalledTimes(2); // First release may already exist; no real transaction proof.
  });
});

const observation = (observationId: string, extra: Partial<LearningObservation> = {}): LearningObservation => ({
  id: observationId, workspaceId: id, sessionId: id, courseId: id, skillLabel: "fractions", sourceIds: [source, otherSource],
  sourceVersions: { [source]: 0 }, problemId: id, itemVersionId: second, attemptId: id, answer: "1/2", outcome: "correct",
  assistance: "independent", clientKey: "synthetic-history", occurredAt: "2026-11-06T00:00:00Z", sourceTurnIds: [],
  verdictSource: "self_report", referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED", historyRevision: 7, requirementKey: "fractions:v1", ...extra,
});
describe("historical student-answer receipt identity", () => {
  it("retains separate observation revisions sharing the same item and their own versioned origin refs", async () => {
    const a = observation(id), b = observation(second, { rootObservationId: id, historyRevision: 8, answer: "2/4" });
    await createOpeningContentDeliveryRepository(db([{ id }])).history(scope, "history", [a, b, a]);
    expect(hooks.deliver.mock.calls.map(c => c[1])).toEqual([a, b].map((o, index) => ({
      releaseKey: `history:history_solution:${index}`, contextAnchor: { purpose: "history_solution", itemVersionId: second },
      origin: "history_solution", originReference: { type: "observation", id: o.id, version: String(o.historyRevision),
        sourceRefs: [{ sourceId: source, sourceVersion: 0 }, { sourceId: otherSource, sourceVersion: null }], skillLabel: "fractions", requirementKey: "fractions:v1" },
      kind: "hint", level: "hinted", supportDomain: "unknown",
    })));
  });
  it.each([
    { label: "item identity takes precedence", patch: {}, course: true, expected: { itemVersionId: second } },
    { label: "attempt fallback", patch: { itemVersionId: null }, course: true, expected: { attemptId: id } },
    { label: "no item or attempt", patch: { itemVersionId: null, attemptId: null }, course: true, expected: {} },
    { label: "unavailable course cannot target the old item", patch: {}, course: false, expected: {} },
  ])("$label without pretending the student's answer is a trusted solution", async ({ patch, course, expected }) => {
    await createOpeningContentDeliveryRepository(db(course ? [{ id }] : [])).history(scope, "anchor", [observation(id, patch)]);
    expect(hooks.deliver).toHaveBeenCalledWith(scope, expect.objectContaining({ contextAnchor: { purpose: "history_solution", ...expected }, kind: "hint", level: "hinted", supportDomain: "unknown" }));
  });
  it("preserves unknown historical revision as zero and missing source versions as null", async () => {
    await createOpeningContentDeliveryRepository(db([{ id }])).history(scope, "legacy", [observation(id, { historyRevision: undefined, sourceVersions: undefined })]);
    expect(hooks.deliver.mock.calls[0]![1].originReference).toMatchObject({ version: "0", sourceRefs: [
      { sourceId: source, sourceVersion: null }, { sourceId: otherSource, sourceVersion: null },
    ] });
  });
});
