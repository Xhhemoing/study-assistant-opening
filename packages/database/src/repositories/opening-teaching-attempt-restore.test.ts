import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTeachingContentRepository } from "./opening-teaching-content";
import { qualifyObservationRevision } from "./opening-observation-revision-history";
vi.mock("./opening-observation-revision-history", () => ({ qualifyObservationRevision: vi.fn() }));
const id = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const scope = { workspaceId: id, ownerUserId: id };
const head = { id, answer: "private original answer", revision_kind: "original" };
const qualified = { id, answer: head.answer, eligibility: { usable: false } };
function database(sourceAvailable: boolean) {
  const sql = ((strings: TemplateStringsArray | unknown[], ..._values: unknown[]) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id }]);
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([{ content_version: 3 }]);
    if (query.includes("FROM opening_learning_attempts")) return Promise.resolve([{ id, workspace_id: id, course_id: id,
      session_id: id, skill_label: "skill", requirement_key: `teaching:${id}:v3`, source_ids: [sourceId], source_versions: { [sourceId]: 1 },
      started_at: new Date(), submitted_at: new Date(), observation_id: id, history_revision: 1 }]);
    if (query.includes("SELECT head.*")) return Promise.resolve([head]);
    if (query.includes("FROM opening_sources")) return Promise.resolve(sourceAvailable ? [{ id: sourceId, version: 1, bytes: 1, sha256: "source" }] : []);
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  return sql;
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(qualifyObservationRevision).mockResolvedValue(qualified as never); });
it("returns the qualified observation including its evidence assessment", async () => {
  const sql = database(true);
  const restored = await createOpeningTeachingContentRepository(sql).getSubmittedAttempt(scope, id, id, 3);
  expect(qualifyObservationRevision).toHaveBeenCalledWith(sql, scope, head);
  expect(restored?.observation).toBe(qualified);
});
it("does not return a derived answer when the shared history privacy boundary rejects it", async () => {
  vi.mocked(qualifyObservationRevision).mockRejectedValue(Object.assign(new Error("observation history unavailable"), { code: "NOT_FOUND" }));
  await expect(createOpeningTeachingContentRepository(database(true)).getSubmittedAttempt(scope, id, id, 3))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("also rejects a missing or excluded original attempt source even when head qualification succeeds", async () => {
  await expect(createOpeningTeachingContentRepository(database(false)).getSubmittedAttempt(scope, id, id, 3))
    .rejects.toMatchObject({ code: "VALIDATION", message: "source unavailable or privacy-excluded" });
});
