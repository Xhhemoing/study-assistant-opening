import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { gradeCard } from "./cards-grade";
import { createInitialState } from "@aistudy/domain";
import { appendLearningEventInputSchema, learningEventSchema, observationInputSchema, reviewStateSchema } from "@aistudy/contracts";
import type { CardRecord } from "./cards-types";

const io = vi.hoisted(() => ({ load: vi.fn(), state: vi.fn(), write: vi.fn(), append: vi.fn(), existing: vi.fn(), session: vi.fn(), observation: vi.fn() }));
vi.mock("./cards-ops", () => ({ assertWorkspaceOwner: vi.fn(), lockCardForUpdate: vi.fn(), loadCard: io.load,
  loadReviewStateForUpdate: io.state, writeState: io.write }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn() }));
vi.mock("./learning-events", async original => ({ ...await original<typeof import("./learning-events")>(),
  createLearningEventRepository: () => ({ append: io.append, findByIdempotency: io.existing }) }));
vi.mock("./opening-learning-session-create", () => ({ createOpeningLearningSessionInTx: io.session }));
vi.mock("./opening-learning-observations", () => ({ insertOpeningLearningObservationInTx: io.observation }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const workspaceId = id(1), ownerUserId = id(2), cardId = id(3), courseId = id(4), now = new Date("2026-11-10T12:00:00Z");
const card: CardRecord = { id: cardId, ownerUserId, front: "Recall", back: "Answer", sourceDocumentId: id(5), syllabusPointId: null,
  tags: [], courseId, skillLabel: "recall", archived: false, contentVersion: 1, pausedUntil: null, maintainUntil: null,
  excludeFromAssessment: false, createdAt: now.toISOString() };
function fixture({ direct = [id(6)], refs = [{ sourceId: id(7), sourceVersion: 0 }] as unknown, provenance = true, admitted = 2, course = true,
  fault = undefined as { prefix: string; error: Error } | undefined, replayHasObservation = true, missingCard = false } = {}) {
  const order: string[] = [];
  const reads: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn((parts: TemplateStringsArray | string[], ...values: unknown[]): unknown => {
    if (!Object.hasOwn(parts, "raw")) return { ids: parts };
    const sql = parts.join("?").replace(/\s+/g, " ").trim(); reads.push({ sql, values });
    if (fault && sql.startsWith(fault.prefix)) return Promise.reject(fault.error);
    if (sql.startsWith("SELECT 1 FROM opening_learning_observations")) return Promise.resolve(replayHasObservation ? [{ present: 1 }] : []);
    if (sql.startsWith("SELECT adaptive_planning")) return Promise.resolve([]);
    if (sql.startsWith("SELECT id FROM courses")) { order.push("course"); return Promise.resolve(course ? [{ id: courseId }] : []); }
    if (sql.startsWith("SELECT c.source_ids")) { order.push("lineage"); return Promise.resolve(missingCard ? [] : [{ source_ids: direct, provenance_id: provenance ? id(5) : null, context_source_refs: refs }]); }
    if (sql.startsWith("SELECT count(*)")) { order.push("admit"); return Promise.resolve([{ n: admitted }]); }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const tx = query as unknown as Sql;
  const pool = vi.fn(() => { throw new Error("storage must use the transaction handle"); });
  const sql = Object.assign(pool, { begin: async (fn: (transaction: Sql) => unknown) => {
    order.push("begin"); try { const result = await fn(tx); order.push("return"); return result; } catch (error) { order.push("reject"); throw error; }
  } }) as unknown as Sql;
  io.load.mockResolvedValue(card); io.state.mockResolvedValue({ ...createInitialState(cardId, now), workspaceId, ownerUserId });
  io.existing.mockResolvedValue(null);
  io.write.mockImplementation(async (_db, _workspace, _owner, state) => {
    order.push("state"); return { ...reviewStateSchema.parse(state), workspaceId, ownerUserId };
  });
  io.append.mockImplementation(async input => {
    order.push("event");
    const parsed = appendLearningEventInputSchema.parse(input);
    return learningEventSchema.parse({ ...parsed, id: id(8), createdAt: now.toISOString() });
  });
  io.session.mockImplementation(async () => { order.push("session"); return { id: id(9) }; });
  io.observation.mockImplementation(async (_tx, _scope, input) => {
    order.push("observation"); observationInputSchema.parse(input); return {};
  });
  const run = (assisted = false, variantObservationId?: string) => gradeCard(sql, { workspaceId, ownerUserId, cardId, grade: "good", idempotencyKey: "lineage-review",
    occurredAt: now.toISOString(), now, assisted, variantObservationId });
  return { sql, tx, pool, reads, order, run };
}
afterEach(() => vi.resetAllMocks());

describe("card review → actual evidence planner → context parser", () => {
  it("keeps canonical union of card and note sources in the actual self-report observation", async () => {
    const f = fixture({ direct: [id(7), id(6), id(6)], refs: [{ sourceId: id(7).toUpperCase(), sourceVersion: 0 }, { sourceId: id(10), sourceVersion: 2 }], admitted: 3 });
    expect(await f.run()).toMatchObject({ created: true, evidence: "recorded", state: { reps: 1 } });
    expect(f.order).toEqual(["begin", "state", "event", "course", "lineage", "admit", "session", "observation", "return"]);
    expect(f.pool).not.toHaveBeenCalled();
    expect(io.write).toHaveBeenCalledExactlyOnceWith(f.tx, workspaceId, ownerUserId, expect.objectContaining({ cardId, reps: 1 }));
    expect(io.session).toHaveBeenCalledExactlyOnceWith(f.tx, { workspaceId, ownerUserId }, { courseId, skillLabel: "recall", sourceIds: [id(6), id(7), id(10)] });
    expect(io.observation).toHaveBeenCalledExactlyOnceWith(f.tx, { workspaceId, ownerUserId }, expect.objectContaining({
      sessionId: id(9), courseId, sourceIds: [id(6), id(7), id(10)], verdictSource: "self_report", assistance: "independent", clientKey: `card-review:${id(8)}` }));
    const admission = f.reads.find(r => r.sql.startsWith("SELECT count(*)"))!;
    expect(admission.values).toEqual([workspaceId, { ids: [id(6), id(7), id(10)] }, workspaceId]);
    expect(admission.sql).toBe("SELECT count(*)::int AS n FROM opening_sources s WHERE s.workspace_id=? AND s.id IN ? AND s.upload_state='uploaded' AND EXISTS (SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version) AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=? AND e.source_id=s.id)");
  });
  it.each([
    ["unknown note lineage", null], ["null entry", [null]],
    ["valid plus malformed entry", [{ sourceId: id(7), sourceVersion: 0 }, null]],
    ["missing version", [{ sourceId: id(7) }]], ["string version", [{ sourceId: id(7), sourceVersion: "0" }]],
  ])("preserves SRS/event but skips evidence for %s", async (_name, refs) => {
    const f = fixture({ refs });
    expect(await f.run()).toMatchObject({ created: true, evidence: "skipped_source_unavailable", state: { reps: 1 } });
    expect(f.order).toEqual(["begin", "state", "event", "course", "lineage", "return"]);
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    expect(io.write).toHaveBeenCalledOnce(); expect(io.append).toHaveBeenCalledOnce();
  });
  it.each([0, 1, 3])("requires exact admission cardinality for both consumed sources, not count %s", async admitted => {
    const f = fixture({ admitted });
    expect(await f.run()).toMatchObject({ evidence: "skipped_source_unavailable", state: { reps: 1 } });
    expect(io.observation).not.toHaveBeenCalled();
    expect(f.order).toContain("event"); expect(f.order).toContain("admit");
  });
  it("does not treat an unlinked card's irrelevant note JSON as consumed lineage", async () => {
    const f = fixture({ provenance: false, refs: null, admitted: 1 });
    expect(await f.run()).toMatchObject({ evidence: "recorded" });
    expect(io.observation).toHaveBeenCalledWith(f.tx, expect.anything(), expect.objectContaining({ sourceIds: [id(6)] }));
  });
  it("allows genuinely source-free known note context without a source query", async () => {
    const f = fixture({ direct: [], refs: [], admitted: 0 });
    expect(await f.run()).toMatchObject({ evidence: "recorded" });
    expect(f.order).not.toContain("admit");
    expect(io.observation).toHaveBeenCalledWith(f.tx, expect.anything(), expect.objectContaining({ sourceIds: [] }));
  });
  it("normalizes an uppercase consumed note UUID before source admission and observation", async () => {
    const sourceId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    const refs = [{ sourceId: sourceId.toUpperCase(), sourceVersion: 0 }];
    const f = fixture({ direct: [sourceId], refs, admitted: 1 });
    expect(await f.run()).toMatchObject({ evidence: "recorded" });
    expect(io.session).toHaveBeenCalledWith(f.tx, expect.anything(), expect.objectContaining({ sourceIds: [sourceId] }));
    expect(io.observation).toHaveBeenCalledWith(f.tx, expect.anything(), expect.objectContaining({ sourceIds: [sourceId] }));
    expect(refs[0]!.sourceId).toBe("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF");
  });
  it("does not mutate the card's direct IDs or the note provenance while building the sorted union", async () => {
    const direct = [id(7), id(6), id(6)], refs = [{ sourceId: id(7), sourceVersion: 0 }];
    const before = structuredClone({ direct, refs });
    const f = fixture({ direct, refs });
    expect(await f.run()).toMatchObject({ evidence: "recorded" });
    expect({ direct, refs }).toEqual(before);
  });
  it.each([
    "SELECT id FROM courses", "SELECT c.source_ids", "SELECT count(*)",
  ])("propagates planner storage failure at %s instead of pretending SRS-only success", async prefix => {
    const error = Object.assign(new Error("planner read unavailable"), { code: "ECONNRESET" });
    const f = fixture({ fault: { prefix, error } });
    await expect(f.run()).rejects.toBe(error);
    expect(f.order.at(-1)).toBe("reject");
    expect(io.write).toHaveBeenCalledOnce(); expect(io.append).toHaveBeenCalledOnce();
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    // These prior mock writes are attempted calls, not evidence of committed SRS.
  });
  it("does not silently downgrade a disappeared card to SRS-only after preflight", async () => {
    const f = fixture({ missingCard: true });
    await expect(f.run()).rejects.toMatchObject({ code: "NOT_FOUND", message: "card not found" });
    expect(f.order).toEqual(["begin", "state", "event", "course", "lineage", "reject"]);
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    expect(f.pool).not.toHaveBeenCalled();
  });
  it.each(["session", "observation"])("preserves failure from evidence %s and never returns recorded", async boundary => {
    const error = new Error(`failed ${boundary}`);
    const f = fixture();
    if (boundary === "session") io.session.mockRejectedValueOnce(error);
    else io.observation.mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.order.at(-1)).toBe("reject");
    expect(io.session).toHaveBeenCalledOnce();
    expect(io.observation).toHaveBeenCalledTimes(boundary === "session" ? 0 : 1);
  });
  it("replays a recorded review without rereading now-unavailable lineage or appending another fact", async () => {
    const f = fixture({ refs: [null], admitted: 0 });
    const existing = { id: id(8), type: "review", contentId: cardId, payload: { grade: "good" } };
    io.existing.mockResolvedValueOnce(existing);
    expect(await f.run()).toMatchObject({ event: existing, created: false, evidence: "recorded" });
    expect(f.order).toEqual(["begin", "return"]);
    expect(io.write).not.toHaveBeenCalled(); expect(io.append).not.toHaveBeenCalled();
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    expect(f.reads.map(r => r.sql)).toHaveLength(1);
    expect(f.reads[0]!.values).toEqual([workspaceId, ownerUserId, `card-review:${id(8)}`]);
  });
  it("does not promote an old skipped review after its source inventory becomes eligible", async () => {
    const f = fixture({ replayHasObservation: false });
    const existing = { id: id(8), type: "review", contentId: cardId, payload: { grade: "good" } };
    io.existing.mockResolvedValueOnce(existing);
    expect(await f.run()).toMatchObject({ event: existing, created: false, evidence: "skipped_unknown" });
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]!.sql).toMatch(/^SELECT 1 FROM opening_learning_observations/);
    expect(io.write).not.toHaveBeenCalled(); expect(io.append).not.toHaveBeenCalled();
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
  });
  it("stops before event or planner work when the SRS state writer fails", async () => {
    const error = new Error("state write failed");
    const f = fixture(); io.write.mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(io.append).not.toHaveBeenCalled(); expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    expect(f.reads.some(r => r.sql.startsWith("SELECT c.source_ids"))).toBe(false);
    expect(f.order.at(-1)).toBe("reject");
  });
  it("stops before lineage admission when appending the review event fails", async () => {
    const error = new Error("event append failed");
    const f = fixture(); io.append.mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(io.write).toHaveBeenCalledOnce();
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    expect(f.reads.some(r => r.sql.startsWith("SELECT id FROM courses"))).toBe(false);
    expect(f.order.at(-1)).toBe("reject");
  });
  it("does not create a second self-report observation for a server-validated variant", async () => {
    const f = fixture({ refs: [null], admitted: 0 });
    expect(await f.run(false, id(99))).toMatchObject({ created: true, evidence: "recorded", state: { reps: 1 } });
    expect(f.order).toEqual(["begin", "state", "event", "return"]);
    expect(io.session).not.toHaveBeenCalled(); expect(io.observation).not.toHaveBeenCalled();
    expect(f.reads.some(r => r.sql.startsWith("SELECT c.source_ids"))).toBe(false);
  });
  it("keeps 32 unique sources eligible even with a 33rd duplicate provenance entry", async () => {
    const direct = Array.from({ length: 32 }, (_, n) => id(20 + n));
    const f = fixture({ direct: [...direct, direct[0]!], refs: [{ sourceId: direct[0], sourceVersion: 0 }], admitted: 32 });
    expect(await f.run()).toMatchObject({ evidence: "recorded" });
    expect(io.observation).toHaveBeenCalledWith(f.tx, expect.anything(), expect.objectContaining({ sourceIds: direct }));
  });
  it("treats source-version variants as one admission source without mutating provenance versions", async () => {
    const refs = [{ sourceId: id(7), sourceVersion: 0 }, { sourceId: id(7), sourceVersion: 1 }];
    const f = fixture({ direct: [], refs, admitted: 1 });
    expect(await f.run()).toMatchObject({ evidence: "recorded" });
    expect(io.observation).toHaveBeenCalledWith(f.tx, expect.anything(), expect.objectContaining({ sourceIds: [id(7)] }));
    expect(refs.map(ref => ref.sourceVersion)).toEqual([0, 1]);
    // Planner admits current source IDs, not historical version equivalence.
  });
  it.each([32, 33])("bounds the union after deduplication at %s sources", async count => {
    const direct = Array.from({ length: count }, (_, n) => id(20 + n));
    const f = fixture({ direct, refs: [{ sourceId: direct[0], sourceVersion: 1 }], admitted: count });
    expect(await f.run()).toMatchObject({ evidence: count === 32 ? "recorded" : "skipped_source_unavailable" });
    expect(f.order.includes("admit")).toBe(count === 32);
    expect(io.observation).toHaveBeenCalledTimes(count === 32 ? 1 : 0);
  });
});
