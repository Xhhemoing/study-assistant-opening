import { describe, expect, it } from "vitest";
import { systemQueryRequestSchema, systemQueryEvidenceSchema } from "./system-query";
import { providerInputSchema } from "./tutor";
const input = { instruction: "read", text: "what?", chunks: [], mode: "listen", maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [],
  tools: [{ name: "courses", description: "read", parameters: {} }] };
describe("read-only query contracts", () => {
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
