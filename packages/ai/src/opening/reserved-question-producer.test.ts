import { describe, expect, it, vi } from "vitest";
import { produceReservedQuestion, type ReservedQuestionProducerInput } from "./reserved-question-producer";

const input: ReservedQuestionProducerInput = {
  scope: { workspaceId: "workspace", ownerUserId: "owner" }, courseId: "course", requirementId: "requirement",
  requirementRevision: 2, sourceVersions: { source: 3 }, requirementText: "Addition", evidence: { chunks: [] },
};
const proposal = { text: "291 + 2 = ?", answer: "293", interaction: { kind: "numeric" } };
describe("private reserved question producer", () => {
  it("routes a generated proposal only to server admission and returns an opaque ref", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify(proposal));
    const admitAndPersist = vi.fn().mockResolvedValue({ privateRefId: "private-ref" });
    const result = await produceReservedQuestion(input, { generate, admitAndPersist });
    expect(result).toEqual({ kind: "persisted", privateRefId: "private-ref" });
    expect(admitAndPersist).toHaveBeenCalledExactlyOnceWith({ ...proposal, scope: input.scope,
      courseId: "course", requirementId: "requirement", requirementRevision: 2, sourceVersions: { source: 3 } });
    const request = generate.mock.calls[0]![0];
    expect(request).toMatchObject({ chunks: [], imageParts: [], outputFormat: "json", mediaCapability: "text_only" });
    expect(JSON.stringify(request)).not.toContain(proposal.answer);
    expect(JSON.stringify(result)).not.toContain(proposal.text);
    expect(JSON.stringify(result)).not.toContain(proposal.answer);
  });
  it.each(["not JSON", "null", "[]", "{}", "x".repeat(24001),
    JSON.stringify({ ...proposal, identity: { trusted: true } }),
    JSON.stringify({ ...proposal, ready: true }), JSON.stringify({ ...proposal, unseen: true }),
    JSON.stringify({ ...proposal, familyId: "model-asserted-family" }),
    JSON.stringify({ ...proposal, key: { verified: true } }),
    JSON.stringify({ ...proposal, answer: "" }),
    JSON.stringify({ ...proposal, interaction: { kind: "choice", options: [] } }),
  ])("does not persist malformed or authority-claiming model output %#", async raw => {
    const admitAndPersist = vi.fn();
    expect(await produceReservedQuestion(input, { generate: async () => raw, admitAndPersist }))
      .toEqual({ kind: "unavailable", reason: "invalid_output" });
    expect(admitAndPersist).not.toHaveBeenCalled();
  });
  it("does not turn a plausible model key into admitted supply", async () => {
    expect(await produceReservedQuestion(input, { generate: async () => JSON.stringify(proposal), admitAndPersist: async () => null }))
      .toEqual({ kind: "unavailable", reason: "not_admitted" });
  });
  it("pins the context before generation and lets repository reject stale versions", async () => {
    const mutable = structuredClone(input), admitAndPersist = vi.fn().mockResolvedValue(null);
    await produceReservedQuestion(mutable, { generate: async () => {
      mutable.sourceVersions.source = 4; mutable.requirementRevision = 3;
      return JSON.stringify(proposal);
    }, admitAndPersist });
    expect(admitAndPersist.mock.calls[0]![0]).toMatchObject({ sourceVersions: { source: 3 }, requirementRevision: 2 });
  });
  it("propagates generation failures without persistence or retry", async () => {
    const error = new Error("budget replay"), generate = vi.fn().mockRejectedValue(error), admitAndPersist = vi.fn();
    await expect(produceReservedQuestion(input, { generate, admitAndPersist })).rejects.toBe(error);
    expect(generate).toHaveBeenCalledTimes(1); expect(admitAndPersist).not.toHaveBeenCalled();
  });
  it("does not swallow admission/transaction failures", async () => {
    const error = new Error("transaction rolled back"), admitAndPersist = vi.fn().mockRejectedValue(error);
    await expect(produceReservedQuestion(input, { generate: async () => JSON.stringify(proposal), admitAndPersist })).rejects.toBe(error);
    expect(admitAndPersist).toHaveBeenCalledTimes(1);
  });
});
