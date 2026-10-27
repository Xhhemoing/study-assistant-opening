import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { expect, it, vi } from "vitest";
import { SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
const { cancel } = vi.hoisted(() => ({ cancel: vi.fn(async () => []) }));
vi.mock("./opening-span-tutor-budget", () => ({ cancelOwnedSpanTutorRetests: cancel }));
import { reconcileOpeningRetestEvidence } from "./opening-retests";
it("closes only activity identities invalidated by this evidence revision in the same transaction", async () => {
  const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() }, courseId = randomUUID(), root = randomUUID(), activityId = randomUUID();
  const candidate = (evidenceRoot: string) => ({ id: randomUUID(), courseId, skillLabel: SPAN_SKILL_LABEL,
    requirementKey: SPAN_REQUIREMENT_KEY, prompt: "retest", sourceIds: [], dueAt: "2026-10-30T00:00:00Z",
    accepted: true, kind: "task", evidenceRootIds: [evidenceRoot], evidenceObservationIds: [evidenceRoot] });
  const linked = candidate(root), unrelated = candidate(randomUUID());
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT id,payload FROM opening_jobs")) return Promise.resolve([{ id: linked.id, payload: linked }, { id: unrelated.id, payload: unrelated }]);
    if (query.startsWith("UPDATE opening_retest_activities SET status='invalidated'")) return Promise.resolve([{ id: activityId }]);
    return Promise.resolve([]);
  }) as unknown as TransactionSql;
  sql.json = ((value: unknown) => value) as TransactionSql["json"];
  const identity = { courseId, skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY };
  await reconcileOpeningRetestEvidence(sql, scope, { rootObservationId: root, previousHeadObservationId: root,
    headObservationId: randomUUID(), previousIdentity: identity, currentIdentity: null, historyRevision: 2 });
  expect(cancel).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(sql, scope, { activityIds: [activityId], reason: "evidence_changed" });
});
