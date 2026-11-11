import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { projectMaterialFeedback, projectMaterialFirstAnswer } from "./material-attempt-presentation";

const question = () => ({ id: "source-question-1", sourceFile: "practice.pdf", physicalPage: 2,
  prompt: { role: "prompt", text: "Compute 2 + 3." } });
const promptAuthority = { verifyPrompt: () => true };
const privateKeys = ["postAttemptNotes", "notes", "learningObjectives", "commonErrors", "primarySkillId", "secondarySkillIds",
  "skillTitle", "skills", "answer", "answerKey", "privateAnswerKeys", "payload", "canonicalFamilyId", "mastery", "bktEligible"];
function poison(input: object, keys = privateKeys) {
  const read = vi.fn(() => { throw new Error("PRIVATE_GETTER_EXECUTED"); });
  for (const key of keys) Object.defineProperty(input, key, { enumerable: true, get: read });
  return read;
}

describe("material first-answer privacy projection", () => {
  it("returns exactly the whitelist, never touching private enumerable getters", () => {
    const input = question();
    const reads = poison(input);
    const result = projectMaterialFirstAnswer(input, promptAuthority);
    expect(result).toEqual({ kind: "material_first_answer", status: "available", questionId: input.id,
      source: { file: "practice.pdf", page: 2 }, prompt: { role: "prompt", text: "Compute 2 + 3." } });
    expect(reads).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("never uses notes or teaching metadata to fill a missing prompt", () => {
    const input = { id: "source-question-1", sourceFile: "practice.pdf", physicalPage: 2 };
    const reads = poison(input);
    const verifyPrompt = vi.fn(() => true);
    expect(projectMaterialFirstAnswer(input, { verifyPrompt })).toEqual({ kind: "material_first_answer", status: "unavailable",
      questionId: input.id, source: { file: "practice.pdf", page: 2 }, reason: "missing_prompt_body" });
    expect(reads).not.toHaveBeenCalled();
    expect(verifyPrompt).not.toHaveBeenCalled();
  });

  it("does not trust a typed-looking prompt, source identity or client verification flags", () => {
    const input = { ...question(), verified: true, promptVerified: true, mappingStatus: "text-reviewed" };
    expect(projectMaterialFirstAnswer(input)).toMatchObject({ status: "unavailable", reason: "prompt_not_verified" });
    expect(projectMaterialFirstAnswer(input, { verifyPrompt: () => false })).toMatchObject({ status: "unavailable" });
    const verifyPrompt = vi.fn(() => true);
    expect(projectMaterialFirstAnswer(input, { verifyPrompt }).status).toBe("available");
    expect(verifyPrompt).toHaveBeenCalledWith({ questionId: input.id, source: { file: "practice.pdf", page: 2 }, text: "Compute 2 + 3." });
  });

  it.each([null, "", "   ", { text: "Nested body" }, { role: "answer_key", text: "5" }, { role: "prompt", text: { answer: "5" } }])(
    "rejects absent/wrong-role/non-text prompt %#", prompt => {
      expect(projectMaterialFirstAnswer({ ...question(), prompt }, promptAuthority)).toMatchObject({ status: "unavailable", reason: "missing_prompt_body" });
    });

  it("does not execute accessors or coercion even in allowlisted fields", () => {
    const input = question();
    const reads = poison(input.prompt, ["text"]);
    expect(projectMaterialFirstAnswer(input, promptAuthority).status).toBe("unavailable");
    expect(reads).not.toHaveBeenCalled();
    const toString = vi.fn(() => "Compute 2 + 3.");
    expect(projectMaterialFirstAnswer({ ...question(), prompt: { role: "prompt", text: { toString } } }, promptAuthority).status).toBe("unavailable");
    expect(toString).not.toHaveBeenCalled();
  });
});

const feedbackRequest = () => ({ questionId: "source-question-1", attemptId: "attempt-1", mode: "post_attempt" });
const approvedFeedback = { postAttemptNotes: "Check the sum.", answer: null };
const feedbackAuthority = { resolveFeedback: () => ({ ...approvedFeedback }) };
describe("material feedback host boundary", () => {
  it("does not read private data before authorization, including self-signed post-attempt/help claims", () => {
    const input = question();
    const reads = poison(input);
    for (const mode of ["post_attempt", "explicit_help"]) {
      const request = { ...feedbackRequest(), mode, submitted: true, authorized: true, trusted: true, helpRequested: true };
      expect(projectMaterialFeedback(input, request)).toEqual({ kind: "material_feedback", status: "unavailable", reason: "feedback_not_authorized" });
      expect(projectMaterialFeedback(input, request, { resolveFeedback: () => null })).toEqual({ kind: "material_feedback", status: "unavailable", reason: "feedback_not_authorized" });
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it("projects only authorized notes/answer after host-verified submission", () => {
    const input = { ...question(), postAttemptNotes: "Check the sum.", answer: { role: "answer_key", text: "5", extraAnswerKey: "PRIVATE_EXTRA" } };
    const reads = poison(input, ["learningObjectives", "commonErrors", "payload", "skills", "privateAnswerKeys"]);
    const resolveFeedback = vi.fn(() => ({ postAttemptNotes: "Check the sum.", answer: "5" }));
    expect(projectMaterialFeedback(input, feedbackRequest(), { resolveFeedback })).toEqual({ kind: "material_feedback", status: "available",
      questionId: input.id, source: { file: "practice.pdf", page: 2 }, attemptId: "attempt-1", exposure: "post_attempt", independentEligibility: "unknown",
      feedback: { postAttemptNotes: "Check the sum.", answer: "5" } });
    expect(resolveFeedback).toHaveBeenCalledWith({ questionId: input.id, source: { file: "practice.pdf", page: 2 }, attemptId: "attempt-1", mode: "post_attempt" });
    expect(reads).not.toHaveBeenCalled();
  });

  it("labels authorized early feedback help/non-independent without minting an evidence receipt", () => {
    const input = { ...question(), postAttemptNotes: "Check the sum." };
    expect(projectMaterialFeedback(input, { ...feedbackRequest(), mode: "explicit_help" }, feedbackAuthority)).toEqual({
      kind: "material_feedback", status: "available", questionId: input.id, source: { file: "practice.pdf", page: 2 }, attemptId: "attempt-1",
      exposure: "help", independentEligibility: "non_independent", feedback: { postAttemptNotes: "Check the sum.", answer: null },
    });
  });

  it.each([
    {}, { ...feedbackRequest(), questionId: "another-question" }, { ...feedbackRequest(), attemptId: "" },
    { ...feedbackRequest(), mode: "first_answer" }, { ...feedbackRequest(), attemptId: { nested: "attempt-1" } },
  ])("rejects invalid or mismatched request before the host gate %#", request => {
    const input = question();
    const reads = poison(input);
    const resolveFeedback = vi.fn(() => ({ ...approvedFeedback }));
    expect(projectMaterialFeedback(input, request, { resolveFeedback })).toMatchObject({ status: "unavailable", reason: "invalid_request" });
    expect(reads).not.toHaveBeenCalled();
    expect(resolveFeedback).not.toHaveBeenCalled();
  });

  it("does not silently swallow host verifier failures or return private data", () => {
    const input = question();
    const reads = poison(input);
    expect(() => projectMaterialFeedback(input, feedbackRequest(), { resolveFeedback: () => { throw new Error("host unavailable"); } })).toThrow("host unavailable");
    expect(reads).not.toHaveBeenCalled();
  });
});

const SENTINEL = "PRIVATE_SENTINEL_DO_NOT_DISPLAY";
describe("enumerable and nested payload negative controls", () => {
  it("drops every private key and nested payload rather than serializing typed objects", () => {
    const input = Object.assign(question(), Object.fromEntries(privateKeys.map(key => [key, { nested: { answerKey: SENTINEL } }])));
    Object.assign(input.prompt, { answerKey: SENTINEL, payload: { explanation: SENTINEL }, learningObjectives: [SENTINEL] });
    const reads = poison(input.prompt, ["toJSON", "extraAnswerKey"]);
    const result = projectMaterialFirstAnswer(input, promptAuthority);
    expect(result).toEqual({ kind: "material_first_answer", status: "available", questionId: "source-question-1",
      source: { file: "practice.pdf", page: 2 }, prompt: { role: "prompt", text: "Compute 2 + 3." } });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(reads).not.toHaveBeenCalled();
  });

  it("refuses a note/answer disguised as prompt unless the trusted host independently verifies exact text", () => {
    const input = { ...question(), prompt: { role: "prompt", text: SENTINEL }, promptVerified: true };
    const verifyPrompt = vi.fn(({ text }: { text: string }) => text === "Compute 2 + 3.");
    const result = projectMaterialFirstAnswer(input, { verifyPrompt });
    expect(result).toMatchObject({ status: "unavailable", reason: "prompt_not_verified" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("rejects inherited/accessor identity, prompt and nested text without executing them", () => {
    expect(projectMaterialFirstAnswer(Object.create(question()), promptAuthority)).toMatchObject({ status: "unavailable", reason: "invalid_public_identity" });
    for (const key of ["id", "sourceFile", "physicalPage", "prompt"]) {
      const input = question();
      const reads = poison(input, [key]);
      expect(projectMaterialFirstAnswer(input, promptAuthority).status).toBe("unavailable");
      expect(reads).not.toHaveBeenCalled();
    }
    const input = question();
    const reads = poison(input.prompt, ["role"]);
    expect(projectMaterialFirstAnswer(input, promptAuthority).status).toBe("unavailable");
    expect(reads).not.toHaveBeenCalled();
  });

  it.each([null, [], SENTINEL, 5, { id: { nested: SENTINEL }, sourceFile: "practice.pdf", physicalPage: 2 },
    { ...question(), physicalPage: 0 }, { ...question(), physicalPage: 1.5 }, { ...question(), physicalPage: NaN },
    { ...question(), sourceFile: " " }, { ...question(), id: "x".repeat(201) }])("fails closed for invalid public metadata %#", input => {
    const result = projectMaterialFirstAnswer(input, promptAuthority);
    expect(result).toEqual({ kind: "material_first_answer", status: "unavailable", questionId: null, source: null, reason: "invalid_public_identity" });
  });

  it("does not execute private accessors even after authorization", () => {
    const input = question();
    const reads = poison(input);
    expect(projectMaterialFeedback(input, feedbackRequest(), { resolveFeedback: () => ({ postAttemptNotes: null, answer: null }) })).toEqual({ kind: "material_feedback", status: "unavailable", reason: "missing_feedback" });
    expect(reads).not.toHaveBeenCalled();
  });

  it.each([
    { postAttemptNotes: { payload: SENTINEL }, answer: { role: "answer_key", text: { answerKey: SENTINEL } } },
    { postAttemptNotes: [], answer: { role: "prompt", text: SENTINEL } },
    { notes: SENTINEL, payload: { answer: SENTINEL }, answerKey: SENTINEL },
  ])("never converts arbitrary feedback payloads or legacy notes to display text %#", extra => {
    const result = projectMaterialFeedback({ ...question(), ...extra }, feedbackRequest(), { resolveFeedback: () => ({ postAttemptNotes: null, answer: null }) });
    expect(result).toEqual({ kind: "material_feedback", status: "unavailable", reason: "missing_feedback" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("selects only answer role/text and never its extra answer keys or nested payload", () => {
    const answer = { role: "answer_key", text: "5" };
    const reads = poison(answer, ["answerKey", "payload", "explanation", "toJSON"]);
    const result = projectMaterialFeedback({ ...question(), answer }, feedbackRequest(), { resolveFeedback: () => ({ postAttemptNotes: null, answer: "5" }) });
    expect(result).toMatchObject({ status: "available", feedback: { answer: "5", postAttemptNotes: null } });
    expect(reads).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("binds host authorization to the exact question, source, attempt and requested phase", () => {
    const input = { ...question(), postAttemptNotes: "Check the sum." };
    const authority = { resolveFeedback: (r: { questionId: string; source: { file: string; page: number }; attemptId: string; mode: string }) =>
      r.questionId === input.id && r.source.file === "practice.pdf" && r.source.page === 2 && r.attemptId === "attempt-1" && r.mode === "post_attempt"
        ? { ...approvedFeedback } : null };
    expect(projectMaterialFeedback(input, feedbackRequest(), authority).status).toBe("available");
    for (const changed of [{ ...input, sourceFile: "other.pdf" }, { ...input, physicalPage: 3 }, { ...input, id: "other-question" }]) {
      expect(projectMaterialFeedback(changed, { ...feedbackRequest(), questionId: changed.id }, authority).status).toBe("unavailable");
    }
    expect(projectMaterialFeedback(input, { ...feedbackRequest(), attemptId: "attempt-2" }, authority).status).toBe("unavailable");
    expect(projectMaterialFeedback(input, { ...feedbackRequest(), mode: "explicit_help" }, authority).status).toBe("unavailable");
  });

  it("passes detached whitelist objects to authorities and does not accept returned truthy claims", () => {
    const input = question();
    const first = projectMaterialFirstAnswer(input, { verifyPrompt: binding => {
      binding.source.file = SENTINEL;
      binding.text = SENTINEL;
      return true;
    } });
    expect(first).toMatchObject({ source: { file: "practice.pdf" }, prompt: { text: "Compute 2 + 3." } });
    const badPrompt = { verifyPrompt: () => "true" } as unknown as Parameters<typeof projectMaterialFirstAnswer>[1];
    expect(projectMaterialFirstAnswer(input, badPrompt).status).toBe("unavailable");
    const badFeedback = { resolveFeedback: () => ({ authorized: true }) } as unknown as Parameters<typeof projectMaterialFeedback>[2];
    expect(projectMaterialFeedback(input, feedbackRequest(), badFeedback).status).toBe("unavailable");
  });
});

describe("R2 snapshot-only projection", () => {
  it("returns approved feedback without reading any raw private field, even on success", () => {
    const input = question();
    const reads = poison(input);
    const result = projectMaterialFeedback(input, feedbackRequest(), feedbackAuthority);
    expect(result).toMatchObject({ status: "available", feedback: approvedFeedback });
    expect(reads).not.toHaveBeenCalled();
  });

  it("copies only snapshot data fields, never accessors/extras or shared output references", () => {
    const input = question();
    const rawReads = poison(input);
    const snapshot = { postAttemptNotes: "Approved note", answer: "5", payload: { answerKey: SENTINEL } };
    const extraReads = poison(snapshot, ["learningObjectives", "commonErrors", "answerKey", "toJSON"]);
    const result = projectMaterialFeedback(input, feedbackRequest(), { resolveFeedback: () => snapshot });
    expect(result).toMatchObject({ status: "available", feedback: { postAttemptNotes: "Approved note", answer: "5" } });
    snapshot.postAttemptNotes = SENTINEL;
    snapshot.answer = SENTINEL;
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    const snapshotReads = poison(snapshot, ["postAttemptNotes", "answer"]);
    expect(projectMaterialFeedback(input, feedbackRequest(), { resolveFeedback: () => snapshot })).toMatchObject({ status: "unavailable", reason: "missing_feedback" });
    expect(rawReads).not.toHaveBeenCalled();
    expect(extraReads).not.toHaveBeenCalled();
    expect(snapshotReads).not.toHaveBeenCalled();
  });
});

describe("R2 content-bound feedback regressions", () => {
  const currentSnapshot = () => ({ postAttemptNotes: "trusted current feedback", answer: "5" });
  // Both methods let exactly the same three probes execute on frozen R1 and R2.
  // R1's boolean identity gate is insufficient; R2 consumes only resolved data.
  const host = { verifyFeedbackAccess: () => true, resolveFeedback: currentSnapshot };
  const expected = { kind: "material_feedback", status: "available", questionId: "source-question-1",
    source: { file: "practice.pdf", page: 2 }, attemptId: "attempt-1", exposure: "post_attempt",
    independentEligibility: "unknown", feedback: currentSnapshot() };

  it("ignores same-identity foreign notes and answer substitution", () => {
    const input = { ...question(), postAttemptNotes: "FOREIGN_PRIVATE_FEEDBACK", answer: { role: "answer_key", text: "FOREIGN_ANSWER" } };
    const result = projectMaterialFeedback(input, feedbackRequest(), host);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("FOREIGN_");
  });

  it("ignores stale content and self-signed current version claims", () => {
    const input = { ...question(), postAttemptNotes: "OLD_VERSION_PRIVATE_FEEDBACK", answer: { role: "answer_key", text: "OLD_VERSION_ANSWER" },
      version: "current", contentVersion: 999, authorized: true };
    const resolveFeedback = vi.fn(currentSnapshot);
    const result = projectMaterialFeedback(input, { ...feedbackRequest(), version: "current", contentVersion: 999 }, { ...host, resolveFeedback });
    expect(result).toEqual(expected);
    expect(resolveFeedback).toHaveBeenCalledWith({ questionId: "source-question-1",
      source: { file: "practice.pdf", page: 2 }, attemptId: "attempt-1", mode: "post_attempt" });
    expect(JSON.stringify(result)).not.toContain("OLD_VERSION");
  });

  it("ignores raw input mutation during the host callback", () => {
    const input = { ...question(), postAttemptNotes: "trusted current feedback", answer: { role: "answer_key", text: "5" } };
    const mutate = () => {
      input.postAttemptNotes = "REPLACED_AFTER_HOST_CHECK";
      input.answer.text = "FOREIGN_ANSWER";
    };
    const result = projectMaterialFeedback(input, feedbackRequest(), {
      verifyFeedbackAccess: () => { mutate(); return true; },
      resolveFeedback: () => { mutate(); return currentSnapshot(); },
    } as typeof host);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("FOREIGN_");
    expect(JSON.stringify(result)).not.toContain("REPLACED_");
  });
});

// Only the user-designated corrected whole package may be replayed. Never read
// original split packages or copy real material into committed fixtures/logs.
const realInput = process.env.MATERIAL_ATTEMPT_PRESENTATION_INPUT;
const REAL_SHA256 = "041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b";
describe.skipIf(!realInput)("corrected real package: 150 question privacy replay", () => {
  it("keeps all 150 missing bodies unavailable, with no private reads or evidence claims", () => {
    const bytes = readFileSync(realInput!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(REAL_SHA256);
    const pack = JSON.parse(bytes.toString()) as { questions: Record<string, unknown>[] };
    expect(pack.questions).toHaveLength(150);
    const verifyPrompt = vi.fn(() => true);
    for (const raw of pack.questions) {
      expect(Object.hasOwn(raw, "prompt")).toBe(false);
      const input = { ...raw };
      const reads = poison(input);
      const result = projectMaterialFirstAnswer(input, { verifyPrompt });
      expect(result).toEqual({ kind: "material_first_answer", status: "unavailable", questionId: raw.id,
        source: { file: raw.sourceFile, page: raw.physicalPage }, reason: "missing_prompt_body" });
      for (const mode of ["post_attempt", "explicit_help"]) {
        const request = { questionId: raw.id, attemptId: "synthetic-attempt", mode, authorized: true, submitted: true };
        expect(projectMaterialFeedback(input, request)).toEqual({ kind: "material_feedback", status: "unavailable", reason: "feedback_not_authorized" });
        expect(projectMaterialFeedback(input, request, { resolveFeedback: () => null }).status).toBe("unavailable");
      }
      expect(reads).not.toHaveBeenCalled();
      const serialized = JSON.stringify(result);
      for (const key of privateKeys) expect(serialized).not.toContain(`"${key}"`);
    }
    expect(verifyPrompt).not.toHaveBeenCalled();
  });

  it("allows host-authorized feedback only and does not turn 62 composite mappings into BKT/mastery", () => {
    const bytes = readFileSync(realInput!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(REAL_SHA256);
    const pack = JSON.parse(bytes.toString()) as { questions: Record<string, unknown>[] };
    expect(pack.questions.filter(q => Array.isArray(q.secondarySkillIds) && q.secondarySkillIds.length > 0)).toHaveLength(62);
    for (const raw of pack.questions) {
      const input = { ...raw };
      const reads = poison(input);
      // Test-only DI fixture: snapshot captured separately from raw input.
      // This is not a real authenticated/version-bound host implementation.
      const snapshot = { postAttemptNotes: raw.postAttemptNotes as string, answer: null };
      for (const mode of ["post_attempt", "explicit_help"]) {
        const result = projectMaterialFeedback(input, { questionId: raw.id, attemptId: "synthetic-attempt", mode }, { resolveFeedback: () => snapshot });
        expect(result).toEqual({ kind: "material_feedback", status: "available", questionId: raw.id,
          source: { file: raw.sourceFile, page: raw.physicalPage }, attemptId: "synthetic-attempt",
          exposure: mode === "explicit_help" ? "help" : "post_attempt", independentEligibility: mode === "explicit_help" ? "non_independent" : "unknown",
          feedback: { postAttemptNotes: raw.postAttemptNotes, answer: null } });
      }
      expect(reads).not.toHaveBeenCalled();
    }
  });
});
