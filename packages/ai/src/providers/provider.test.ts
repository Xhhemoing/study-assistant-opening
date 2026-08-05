import { describe, expect, it } from "vitest";
import { createProviderRequest, validateProviderResponse } from "./provider";

const editorJob = {
  jobId: "11111111-1111-4111-8111-111111111111",
  explorationId: "22222222-2222-4222-8222-222222222222",
  role: "editor" as const,
  input: "Clarify this paragraph",
  selectedSourceIds: ["source-1"],
  provider: "test-provider",
  model: "test-model",
  promptPolicyVersion: "v1",
};

describe("provider response validation", () => {
  it("parses and normalizes valid candidate output", () => {
    expect(validateProviderResponse({ text: "Hello", candidates: [{ kind: "note", title: " T ", body: " B " }] })).toEqual({
      text: "Hello",
      candidates: [{ kind: "note", title: "T", body: "B" }],
    });
  });

  it("rejects malformed output with a named validation error", () => {
    expect(() => validateProviderResponse({ text: 7, candidates: [] })).toThrowError("AIProviderResponseValidationError");
  });

  it("does not pass source IDs to roles that forbid source retrieval", () => {
    expect(createProviderRequest(editorJob).selectedSourceIds).toEqual([]);
  });
});
