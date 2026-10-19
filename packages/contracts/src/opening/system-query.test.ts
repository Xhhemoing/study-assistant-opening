import { describe, expect, it } from "vitest";
import { systemQueryRequestSchema, systemQueryEvidenceSchema, systemQueryResultSchema } from "./system-query";
import { providerInputSchema } from "./tutor";
const input = { instruction: "read", text: "what?", chunks: [], mode: "listen", maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [],
  tools: [{ name: "courses", description: "read", parameters: {} }] };
describe("read-only query contracts", () => {
  it("rejects invented result tools, invalid qualification values and extra secret fields", () => {
    const common = { status: "ok", reason: "read", asOf: "2026-10-19T00:00:00Z", version: "1", evidence: [], sourceRefs: [], nextOffset: null };
    const id = "00000000-0000-4000-8000-000000000001";
    const observation = { id, rootId: id, attemptId: null, itemVersionId: null, projectionFresh: true, versionApplicability: "exact", liveHelpRevision: 0,
      submittedAt: common.asOf, summary: "actual record", eligibility: { independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown", reasonCodes: [], policyVersion: "opening-evidence-v3" } };
    expect(systemQueryResultSchema.safeParse({ ...common, name: "learning", data: [observation] }).success).toBe(true);
    for (const row of [{ name: "vault", data: [] }, { name: "learning", data: [{ ...observation, eligibility: { ...observation.eligibility, verifiedCorrect: "mastered" } }] },
      { name: "courses", data: [{ id: "00000000-0000-4000-8000-000000000001", title: "x", updatedAt: "2026-10-19T00:00:00Z", goal: null, goalStatus: "not_configured", summary: "x", apiKey: "secret" }] }]) {
      expect(systemQueryResultSchema.safeParse({ ...common, ...row }).success).toBe(false);
    }
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
