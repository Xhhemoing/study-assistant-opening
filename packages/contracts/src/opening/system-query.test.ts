import { describe, expect, it } from "vitest";
import { systemQueryRequestSchema, systemQueryEvidenceSchema, systemQueryResultSchema, systemQueryReceiptSchema } from "./system-query";
import { providerInputSchema } from "./tutor";
const input = { instruction: "read", text: "what?", chunks: [], mode: "listen", maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [],
  tools: [{ name: "courses", description: "read", parameters: {} }] };
describe("read-only query contracts", () => {
  it("binds every result grant, rejects protected bodies in record lookup and bounds UTF-8 receipts", () => {
    const id = "00000000-0000-4000-8000-000000000001", asOf = "2026-10-19T00:00:00Z";
    const authorization = { purpose: "system_record_lookup", workspaceId: id, principalId: id, role: "workspace_owner", permissionRevision: "owner-fixture" };
    const result = { authorization, name: "materials", status: "ok", reason: "read", asOf, version: "1", evidence: [], sourceRefs: [{ sourceId: id, sourceVersion: 1 }], nextOffset: null,
      data: [{ id, sourceId: id, sourceVersion: 1, physicalPage: 1, truncated: false, exposure: "content_withheld", summary: "location only" }] };
    const receipt = { authorization, version: "study-query-v1", asOf, privacyEpoch: 0, mode: "deterministic", status: "ok", reason: "read", results: [result] };
    expect(systemQueryReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(systemQueryReceiptSchema.safeParse({ ...receipt, results: [{ ...result, sourceRefs: [] }] }).success).toBe(false);
    expect(systemQueryReceiptSchema.safeParse({ ...receipt, results: [{ ...result, evidence: [{ id: "link", kind: "material", title: "x", href: `/opening/library?source=${id}&version=2` }] }] }).success).toBe(false);
    expect(systemQueryReceiptSchema.safeParse({ ...receipt, results: [{ ...result, evidence: [{ id: "link", kind: "material", title: "x", href: `/opening/library?source=${id}&source=${id}&version=1` }] }] }).success).toBe(false);
    expect(systemQueryReceiptSchema.safeParse({ ...receipt, results: [{ ...result, authorization: { ...authorization, principalId: "00000000-0000-4000-8000-000000000002" } }] }).success).toBe(false);
    expect(systemQueryReceiptSchema.safeParse({ ...receipt, results: [{ ...result, data: [{ ...result.data[0], excerpt: "protected answer" }] }] }).success).toBe(false);
    expect(systemQueryReceiptSchema.safeParse({ ...receipt, results: [{ ...result, data: Array.from({ length: 3 }, () => ({ ...result.data[0], summary: "中".repeat(12000) })) }] }).success).toBe(false);
  });
  it("rejects invented result tools, invalid qualification values and extra secret fields", () => {
    const common = { authorization: { purpose: "system_record_lookup", workspaceId: "00000000-0000-4000-8000-000000000001", principalId: "00000000-0000-4000-8000-000000000002", role: "workspace_owner", permissionRevision: "owner-fixture" },
      status: "ok", reason: "read", asOf: "2026-10-19T00:00:00Z", version: "1", evidence: [], sourceRefs: [], nextOffset: null };
    const id = "00000000-0000-4000-8000-000000000001";
    const observation = { id, rootId: id, attemptId: null, itemVersionId: null, projectionFresh: true, versionApplicability: "exact", liveHelpRevision: 0,
      submittedAt: common.asOf, summary: "actual record", eligibility: { independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown", reasonCodes: [], policyVersion: "opening-evidence-v3" } };
    expect(systemQueryResultSchema.safeParse({ ...common, name: "learning", data: [observation] }).success).toBe(true);
    for (const row of [{ name: "vault", data: [] }, { name: "learning", data: [{ ...observation, eligibility: { ...observation.eligibility, verifiedCorrect: "mastered" } }] },
      { name: "courses", data: [{ id: "00000000-0000-4000-8000-000000000001", title: "x", updatedAt: "2026-10-19T00:00:00Z", goal: null, goalStatus: "not_configured", summary: "x", apiKey: "secret" }] }]) {
      expect(systemQueryResultSchema.safeParse({ ...common, ...row }).success).toBe(false);
    }
  });
  it("accepts repeated assisted errors and rejects unknown or extra recommendation fields", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const common = { authorization: { purpose: "system_record_lookup", workspaceId: id, principalId: id, role: "workspace_owner", permissionRevision: "owner-fixture" },
      name: "recommendation", status: "ok", reason: "read", asOf: "2026-10-19T00:00:00Z", version: "1", evidence: [], sourceRefs: [], nextOffset: null };
    const recommendation = { identity: { courseId: id, skillLabel: "矩阵乘法", requirementKey: null },
      step: { activityKind: "full_explain", focusObservationId: id, reasonCode: "repeated_assisted_error" },
      evidenceIds: [id], basis: "nextLearningStep/current-evidence", limitations: [], summary: "获得帮助后仍多次在同一步骤出错" };
    const parse = (data: unknown) => systemQueryResultSchema.safeParse({ ...common, data: [data] });
    expect(parse(recommendation).success).toBe(true);
    expect(parse({ ...recommendation, step: { activityKind: "reduced_help_practice", focusObservationId: null, reasonCode: "assisted_success" } }).success).toBe(true);
    expect(parse({ ...recommendation, step: { activityKind: "transfer_check", focusObservationId: id, reasonCode: "correct_needs_independent_check" } }).success).toBe(true);
    expect(parse({ ...recommendation, step: { ...recommendation.step, reasonCode: "independent" } }).success).toBe(true);
    expect(parse({ summary: "无法可靠解释下一学习活动", recommendationStatus: "unknown" }).success).toBe(true);
    for (const data of [
      { ...recommendation, step: { ...recommendation.step, reasonCode: "invented_reason" } },
      { ...recommendation, step: { ...recommendation.step, unexpected: true } },
      { ...recommendation, identity: { ...recommendation.identity, unexpected: true } },
      { ...recommendation, unexpected: true },
      { ...recommendation, step: { activityKind: "transfer_check", reasonCode: "correct_needs_independent_check" } },
      { summary: "无法可靠解释下一学习活动", recommendationStatus: "unknown", step: recommendation.step },
    ]) expect(parse(data).success).toBe(false);
  });
  it.each(systemQueryRequestSchema.options.map(option => option.shape.name.value))("has no model-controlled scope or code for %s", name => {
    expect(systemQueryRequestSchema.safeParse({ name, arguments: { workspaceId: "00000000-0000-4000-8000-000000000001", sql: "SELECT 1" } }).success).toBe(false);
  });
  it.each(["2026-02-30", "2026-99-01", "2026-1-1"])("rejects impossible planning date %s", date => {
    expect(systemQueryRequestSchema.safeParse({ name: "planning", arguments: { date } }).success).toBe(false);
  });
  it("retains bounded defaults and accepts a real leap day", () => {
    expect(systemQueryRequestSchema.parse({ name: "courses", arguments: {} })).toEqual({ name: "courses", arguments: { limit: 5, offset: 0 } });
    expect(systemQueryRequestSchema.safeParse({ name: "planning", arguments: { date: "2028-02-29" } }).success).toBe(true);
  });
  it.each(["https://evil.test", "/opening/../../admin", "javascript:alert(1)"])("rejects non-evidence link %s", href => {
    expect(systemQueryEvidenceSchema.safeParse({ id: "x", kind: "course", title: "x", href }).success).toBe(false);
  });
  it("requires registered calls and exactly one matching result per native transcript id", () => {
    const assistant = { role: "assistant", calls: [{ id: "c1", name: "courses", arguments: "{}" }] };
    const tool = { role: "tool", callId: "c1", text: "[]" };
    expect(providerInputSchema.safeParse({ ...input, toolMessages: [assistant, tool] }).success).toBe(true);
    for (const toolMessages of [[assistant], [tool], [assistant, tool, tool], [assistant, tool, assistant, tool]]) {
      expect(providerInputSchema.safeParse({ ...input, toolMessages }).success).toBe(false);
    }
    expect(providerInputSchema.safeParse({ ...input, tools: [], toolMessages: [assistant, tool] }).success).toBe(false);
  });
});
