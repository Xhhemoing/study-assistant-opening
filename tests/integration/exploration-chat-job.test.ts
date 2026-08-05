import { describe, expect, it } from "vitest";
import type { AIProvider } from "@aistudy/ai";
import { processExplorationChatJob } from "../../apps/worker/src/jobs/exploration-chat";

const request = {
  jobId: "11111111-1111-4111-8111-111111111111",
  explorationId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  role: "tutor" as const,
  input: "Explain this",
  selectedSourceIds: ["source-1"],
  provider: "test-provider",
  model: "test-model",
  promptPolicyVersion: "v1",
};

describe("exploration chat job", () => {
  it("returns validated candidate-only output and provenance", async () => {
    const provider: AIProvider = {
      complete: async () => ({ text: "Reply", candidates: [{ kind: "card", title: "Card", body: "Body" }], requestId: "req-1", costUsd: 0.01 }),
    };
    const result = await processExplorationChatJob(request, provider, () => new Date("2026-08-04T00:00:00.000Z"));
    expect(result.writeMode).toBe("candidate_only");
    expect(result.reply).toBe("Reply");
    expect(result.candidates[0].kind).toBe("card");
    expect(result.provenance).toMatchObject({ provider: "test-provider", model: "test-model", requestId: "req-1", costUsd: 0.01, selectedSourceIds: ["source-1"] });
  });

  it("does not call a provider for silent role", async () => {
    let calls = 0;
    const provider: AIProvider = { complete: async () => { calls += 1; return { text: "bad", candidates: [] }; } };
    const result = await processExplorationChatJob({ ...request, role: "silent" }, provider);
    expect(calls).toBe(0);
    expect(result.reply).toBe("");
    expect(result.candidates).toEqual([]);
    expect(result.writeMode).toBe("candidate_only");
    expect(result.provenance).toMatchObject({ providerRequestStatus: "not_called", requestId: null, costUsd: null });
  });

  it("does not return provider candidates for a retriever role", async () => {
    const provider: AIProvider = {
      complete: async () => ({ text: "Source context", candidates: [{ kind: "note", title: "Candidate", body: "Must not escape retriever" }] }),
    };
    const result = await processExplorationChatJob({ ...request, role: "retriever" }, provider);
    expect(result.reply).toBe("Source context");
    expect(result.candidates).toEqual([]);
  });

  it("fails when the provider response is malformed", async () => {
    const provider: AIProvider = { complete: async () => ({ text: 42, candidates: [] }) };
    await expect(processExplorationChatJob(request, provider)).rejects.toThrow("AIProviderResponseValidationError");
  });

  it("preserves unknown provider request metadata instead of fabricating it", async () => {
    const provider: AIProvider = { complete: async () => ({ text: "Reply", candidates: [] }) };
    const result = await processExplorationChatJob(request, provider);
    expect(result.provenance).toMatchObject({ providerRequestStatus: "completed", requestId: null, costUsd: null });
  });
});
