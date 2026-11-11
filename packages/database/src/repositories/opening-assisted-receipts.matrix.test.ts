import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { spanTutorReceiptDecision } from "./opening-span-tutor-context";
import { createOpeningStudyExposureRepository, generateOpeningStudyExposure, type OpeningStudyExposureInput } from "./opening-study-exposure";
import type { TransactionSql } from "postgres";

// These tests exercise the real repository branches with a recording SQL double.
// No database/transaction/lock/ownership enforcement is claimed by the double.
const hooks = vi.hoisted(() => ({ resolve: vi.fn(), invalidate: vi.fn(), lock: vi.fn() }));
vi.mock("./opening-study-context", () => ({ resolveOpeningStudyContext: hooks.resolve }));
vi.mock("./opening-learning-eligibility", () => ({ invalidateOpeningLearningEligibility: hooks.invalidate }));
vi.mock("./opening-learning-facts", async original => ({ ...await original<typeof import("./opening-learning-facts")>(),
  lockWorkspaceLearningHistory: hooks.lock }));
const id = "10000000-0000-4000-8000-000000000001";
const owner = "10000000-0000-4000-8000-000000000002";
const scope = { workspaceId: id, ownerUserId: owner };
const time = "2026-11-06T00:00:00.000Z";
const policyVersions = ["next-learning-step-1/span-tutor-execution-1", "next-learning-step-2/span-tutor-execution-2",
  "next-learning-step-3/span-tutor-execution-2"];
const decisions = [
  { activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null },
  { activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null },
  { activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null },
  { activityKind: "targeted_explain", reasonCode: "verified_incorrect", focusObservationId: id },
];
describe("v1/v2/v3 historical decision receipt compatibility", () => {
  it.each(policyVersions.flatMap(policyVersion => decisions.map(ruleDecision => ({ policyVersion, ruleDecision }))))(
    "$policyVersion retains $ruleDecision.reasonCode rather than rerunning current D5", ({ policyVersion, ruleDecision }) => {
      const receipt = { policyVersion, intentVersion: JSON.stringify({ courseId: id, ruleDecision, capturedAt: time }) };
      const before = structuredClone(receipt);
      expect(spanTutorReceiptDecision(receipt)).toEqual(ruleDecision);
      expect(spanTutorReceiptDecision(receipt)).toEqual(ruleDecision);
      expect(receipt).toEqual(before);
    });
  it.each(["next-learning-step-1/span-tutor-execution-2", "next-learning-step-2/span-tutor-execution-1",
    "next-learning-step-3/span-tutor-execution-1", "next-learning-step-7/span-tutor-execution-2", "", "true"])(
    "unknown policy %s remains unknown without parsing an unsupported payload", policyVersion => {
      expect(spanTutorReceiptDecision({ policyVersion, intentVersion: "not JSON" })).toBeNull();
    });
  it("keeps an absent receipt unknown", () => expect(spanTutorReceiptDecision(null)).toBeNull());
  it.each(policyVersions)("preserves legacy parser behavior for malformed recognized %s (throws, not fabricated success)", policyVersion => {
    expect(() => spanTutorReceiptDecision({ policyVersion, intentVersion: "{" })).toThrow(SyntaxError);
    // This reader is not a schema boundary: missing ruleDecision remains undefined.
    expect(spanTutorReceiptDecision({ policyVersion, intentVersion: "{}" })).toBeUndefined();
  });
});

const input: OpeningStudyExposureInput = { releaseKey: "fixture-receipt-001", contextAnchor: { purpose: "learning_help", attemptId: id },
  origin: "assistant", kind: "hint", level: "hinted", supportDomain: "unknown" };
function row(extra: Record<string, unknown> = {}) {
  return { id, owner_user_id: owner, release_key: input.releaseKey, release_intent: input,
    context_anchor: input.contextAnchor, exposure_origin: input.origin, support_domain: input.supportDomain,
    generated_at: time, released_at: time, acknowledged_at: null, history_revision: 3,
    hint_stage: null, initiated_by: null, help_input_snapshot: null, ...extra };
}
// Normalize formatting only; retain expression order, predicate columns and numbered binds.
const canonicalAckSql = "UPDATE opening_help_exposures SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()) "
  + "WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 AND released_at IS NOT NULL RETURNING *";
function normalizeAckSql(parts: TemplateStringsArray): string {
  return parts.reduce((sql, part, index) => sql + (index ? `$${index}` : "") + part, "")
    .replace(/\s+/g, " ").replace(/\s*([=,(])\s*/g, "$1").replace(/\s*\)/g, ")").trim();
}
beforeEach(() => vi.clearAllMocks());
describe("legal receipt replay and ACK effects (SQL double, not a real transaction)", () => {
  it.each([null, time])("allows an actual ACK update and preserves the original release (previous ACK=%s)", async previous => {
    const query = vi.fn().mockResolvedValue([row({ acknowledged_at: previous ?? "2026-11-06T00:01:00.000Z" })]);
    const repo = createOpeningStudyExposureRepository(query as unknown as Sql);
    const ack = await repo.acknowledge(scope, id);
    expect(ack).toMatchObject({ id, releasedAt: time, acknowledgedAt: previous ?? "2026-11-06T00:01:00.000Z", historyRevision: 3 });
    expect(query).toHaveBeenCalledOnce();
    const [parts, ...values] = query.mock.calls[0]!;
    // The double maps a supplied row, not an evaluated COALESCE. Verify the emitted
    // expression keeps the existing ACK first, together with each column's binding.
    expect(normalizeAckSql(parts as TemplateStringsArray)).toBe(canonicalAckSql);
    expect(values).toEqual([id, scope.workspaceId, scope.ownerUserId]);
    expect(hooks.resolve).not.toHaveBeenCalled();
    expect(hooks.invalidate).not.toHaveBeenCalled();
  });
  it("does not invent a successful ACK when the scoped SQL operation finds no released row", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await expect(createOpeningStudyExposureRepository(query as unknown as Sql).acknowledge(scope, id))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(query).toHaveBeenCalledOnce();
  });
  it("passes foreign scope to the authorized query rather than dropping its identity", async () => {
    const foreign = { workspaceId: owner, ownerUserId: id };
    const query = vi.fn().mockResolvedValue([]);
    await expect(createOpeningStudyExposureRepository(query as unknown as Sql).acknowledge(foreign, id))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    const [parts, ...values] = query.mock.calls[0]!;
    expect(normalizeAckSql(parts as TemplateStringsArray)).toBe(canonicalAckSql);
    expect(values).toEqual([id, foreign.workspaceId, foreign.ownerUserId]);
  });
  it("propagates ACK storage failure instead of claiming success", async () => {
    const failure = new Error("synthetic storage failure");
    const query = vi.fn().mockRejectedValue(failure);
    await expect(createOpeningStudyExposureRepository(query as unknown as Sql).acknowledge(scope, id)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledOnce();
  });
  it("replays the original receipt without resolving to a newer context or creating extra writes", async () => {
    const query = vi.fn().mockResolvedValue([row()]);
    const receipt = await generateOpeningStudyExposure(query as unknown as TransactionSql, scope, input);
    expect(receipt).toMatchObject({ id, releasedAt: time, acknowledgedAt: null, historyRevision: 3 });
    expect(query).toHaveBeenCalledOnce();
    expect((query.mock.calls[0]![0] as TemplateStringsArray).join("?")).toMatch(/^SELECT /);
    expect(hooks.resolve).not.toHaveBeenCalled();
  });
  it.each([
    { label: "foreign owner", patch: { owner_user_id: id } },
    { label: "changed release intent", patch: { release_intent: { ...input, level: "revealed" } } },
    { label: "changed hint stage", patch: { hint_stage: 2 } },
    { label: "changed initiator", patch: { initiated_by: "assistant" } },
    { label: "changed frozen snapshot", patch: { help_input_snapshot: { forged: true } } },
  ])("refuses replay for $label before any write", async ({ patch }) => {
    const query = vi.fn().mockResolvedValue([row(patch)]);
    await expect(generateOpeningStudyExposure(query as unknown as TransactionSql, scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(query).toHaveBeenCalledOnce();
    expect(hooks.resolve).not.toHaveBeenCalled();
  });
});
