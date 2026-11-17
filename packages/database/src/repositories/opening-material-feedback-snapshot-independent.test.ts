import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createOpeningMaterialFeedbackSnapshotRepository as factory } from "./opening-material-feedback-snapshot";
import { SAVED_ANSWER, harness, present, request, uuid, type StoredFacts, type RepositoryFactory } from "./opening-material-feedback-snapshot-independent.fixture";
import { projectMaterialFeedback } from "../../../domain/src/opening/material-attempt-presentation";

describe("card1 independent real repository / approved DTO (typed SQL fake, not PG)", () => {
  it("returns only a detached approved answer and null notes for the exact submitted binding", async () => {
    const h = harness(factory);
    const snapshot = await h.repo.resolveFeedback(request(h.b));
    expect(snapshot).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    expect(h.host.resolvePostAttemptBinding).toHaveBeenCalledOnce();
    expect(h.db.query).toHaveBeenCalledOnce();
    expect(present(snapshot)).toStrictEqual({ kind: "material_feedback", status: "available", questionId: h.b.blockId,
      source: { file: h.b.sourceFile, page: h.b.physicalPage }, attemptId: h.b.attemptId,
      exposure: "post_attempt", independentEligibility: "unknown", feedback: { postAttemptNotes: null, answer: SAVED_ANSWER } });
  });
  it("cannot substitute raw client feedback for absent host authority", async () => {
    const h = harness(factory);
    h.host.resolvePostAttemptBinding = async () => null;
    expect(present(await h.repo.resolveFeedback(request()))).toStrictEqual({ kind: "material_feedback", status: "unavailable", reason: "feedback_not_authorized" });
    expect(h.db.query).not.toHaveBeenCalled();
  });
  it("allows a different valid version only when trusted binding AND stored facts move together", async () => {
    const h = harness(factory);
    h.b.contentVersion += 1;
    h.b.sourceVersion += 1;
    h.b.sourceSha256 = "c".repeat(64);
    h.b.sourceRefs = [{ sourceId: h.b.sourceId, version: h.b.sourceVersion, page: h.b.physicalPage }];
    Object.assign(h.db.stored.current, structuredClone(h.b));
    h.db.stored.activity.contentVersion = h.b.contentVersion;
    expect(await h.repo.resolveFeedback(request())).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
  });
});

const denials: [string, (s: StoredFacts) => void][] = [
  ["cross workspace", s => { s.attempt.workspaceId = uuid(90); }],
  ["cross owner", s => { s.attempt.ownerUserId = uuid(90); }],
  ["cross course", s => { s.attempt.courseId = uuid(90); }],
  ["cross owner item join", s => { s.item.ownerUserId = uuid(90); }],
  ["cross course item join", s => { s.item.courseId = uuid(90); }],
  ["wrong item version", s => { s.attempt.itemVersionId = uuid(90); }],
  ["wrong problem", s => { s.attempt.problemId = uuid(90); }],
  ["not actually submitted", s => { s.attempt.submittedAt = null; }],
  ["withdrawn document", s => { s.document.deletedAt = new Date(); }],
  ["superseded publication", s => { s.document.currentRevisionNumber += 1; }],
  ["withdrawn activity", s => { s.activity.status = "withdrawn"; }],
  ["unready activity", s => { s.activity.generateStatus = "pending"; }],
  ["private source", s => { s.excluded = true; }],
  ["removed membership", s => { s.membershipRole = null; }],
  ["archived membership", s => { s.membershipRole = "archive"; }],
  ["not uploaded", s => { s.source.uploadState = "pending"; }],
  ["not parsed", s => { s.source.parseState = "pending"; }],
  ["new revision", s => { s.current.revisionId = uuid(90); }],
  ["new content version", s => { s.current.contentVersion += 1; }],
  ["activity spec version mismatch", s => { s.activity.contentVersion += 1; }],
  ["new source version", s => { s.current.sourceVersion += 1; }],
  ["same source version new SHA", s => { s.current.sourceSha256 = "d".repeat(64); }],
  ["same IDs versions changed saved answer", s => {
    (s.current.revisionBlocks as { content: { text: string } }[])[1]!.content.text = "Substituted current answer";
  }],
  ["same IDs versions changed block order", s => { s.current.blockOrder = []; }],
  ["same IDs versions changed source refs", s => { s.current.sourceRefs = []; }],
];
describe("card2 stored facts, not mock row authority", () => {
  it.each(denials)("denies %s even if a tempting mock answer row exists", async (_name, change) => {
    const h = harness(factory);
    h.db.controls.rows = [{ answer: "TEMPTING ROW CANNOT AUTHORIZE", privateExtra: "PRIVATE" }];
    change(h.db.stored);
    const snapshot = await h.repo.resolveFeedback(request());
    expect(snapshot).toBeNull();
    expect(present(snapshot).status).toBe("unavailable");
    expect(h.db.query).toHaveBeenCalledOnce();
  });
  it.each(["question", "attempt", "file", "page"] as const)("denies request %s mismatch before SQL", async field => {
    const h = harness(factory);
    const r = request();
    if (field === "question") r.questionId = uuid(90);
    if (field === "attempt") r.attemptId = uuid(90);
    if (field === "file") r.source.file = "another.pdf";
    if (field === "page") r.source.page += 1;
    expect(await h.repo.resolveFeedback(r)).toBeNull();
    expect(h.db.query).not.toHaveBeenCalled();
  });
  it("does not authorize using client submitted/version/SHA flags", async () => {
    const h = harness(factory);
    h.db.stored.attempt.submittedAt = null;
    const client = { ...request(), submitted: true, contentVersion: h.b.contentVersion, sha256: h.b.sourceSha256, authorized: true };
    expect(await h.repo.resolveFeedback(client)).toBeNull();
  });
  it("denies explicit help before host or SQL: SELECT cannot record exposure", async () => {
    const h = harness(factory);
    expect(await h.repo.resolveFeedback({ ...request(), mode: "explicit_help" })).toBeNull();
    expect(h.host.resolvePostAttemptBinding).not.toHaveBeenCalled();
    expect(h.db.query).not.toHaveBeenCalled();
  });
  // Private acceptance only: default CI has neither this env var nor the course package.
  it.skipIf(!process.env.MATERIAL_FEEDBACK_REAL_INPUT)("replays all exact real 150 questions without invented import binding: all unavailable", async () => {
    const path = process.env.MATERIAL_FEEDBACK_REAL_INPUT;
    if (!path) throw new Error("Set MATERIAL_FEEDBACK_REAL_INPUT to the corrected private whole course package");
    const bytes = readFileSync(path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    const input = JSON.parse(bytes.toString()) as { status: string; questions: { id: string; sourceFile: string; physicalPage: number }[] };
    expect(input.status).toBe("offline-candidate-not-imported");
    expect(input.questions).toHaveLength(150);
    const h = harness(factory);
    h.host.resolvePostAttemptBinding = async () => null;
    for (const q of input.questions) {
      const r = { questionId: q.id, attemptId: uuid(4), mode: "post_attempt" as const, source: { file: q.sourceFile, page: q.physicalPage } };
      const snapshot = await h.repo.resolveFeedback(r);
      expect(snapshot).toBeNull();
      expect(projectMaterialFeedback(q, r, { resolveFeedback: () => snapshot }).status).toBe("unavailable");
    }
    expect(h.db.query).not.toHaveBeenCalled();
  });
});

describe("card3 exceptions, isolation and TOCTOU (trusted typed host port)", () => {
  it("never invokes a row answer getter or promotes an inherited answer", async () => {
    const h = harness(factory);
    const getter = vi.fn(() => { throw new Error("answer getter must not run"); });
    h.db.controls.rows = [Object.defineProperty({}, "answer", { get: getter }) as { answer: unknown }];
    expect(await h.repo.resolveFeedback(request())).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    h.db.controls.rows = [Object.create({ answer: "PROTOTYPE ANSWER" }) as { answer: unknown }];
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it.each([null, {}, 42, "", "   ", "x".repeat(20001)])("rejects invalid answer value %#", async answer => {
    const h = harness(factory);
    h.db.controls.rows = [{ answer }];
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it("denies zero and ambiguous multiple rows rather than picking an answer", async () => {
    const h = harness(factory);
    h.db.controls.rows = [];
    expect(await h.repo.resolveFeedback(request())).toBeNull();
    h.db.controls.rows = [{ answer: SAVED_ANSWER }, { answer: "ambiguous" }];
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it("does not enumerate extra row getters or serialize private columns", async () => {
    const h = harness(factory);
    const getter = vi.fn(() => { throw new Error("private getter"); });
    h.db.controls.rows = [Object.defineProperty({ answer: SAVED_ANSWER }, "privateExtra", { enumerable: true, get: getter })];
    expect(await h.repo.resolveFeedback(request())).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    expect(getter).not.toHaveBeenCalled();
  });
  it("ignores prototype pollution of notes and output qualification fields", async () => {
    const h = harness(factory);
    h.db.controls.rows = [Object.assign(Object.create({ postAttemptNotes: "POISONED NOTES", mastery: true,
      independentEligibility: "independent", constructor: "POISONED" }) as { answer: string }, { answer: SAVED_ANSWER })];
    const snapshot = await h.repo.resolveFeedback(request());
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(snapshot).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    const dto = present(snapshot);
    expect(dto).not.toHaveProperty("mastery");
    expect(dto).not.toHaveProperty("constructor", "POISONED");
    expect(dto).toHaveProperty("independentEligibility", "unknown");
  });
  it("propagates SQL/storage failures, never false success", async () => {
    const h = harness(factory);
    const error = new Error("independent storage failure");
    h.db.controls.error = error;
    await expect(h.repo.resolveFeedback(request())).rejects.toBe(error);
  });
  it("propagates host and trusted binding getter failures without SQL", async () => {
    const h = harness(factory);
    const error = new Error("trusted boundary failure");
    h.host.resolvePostAttemptBinding = async () => { throw error; };
    await expect(h.repo.resolveFeedback(request())).rejects.toBe(error);
    h.host.resolvePostAttemptBinding = async () => Object.defineProperty(h.b, "revisionBlocks", { enumerable: true, get: () => { throw error; } });
    await expect(h.repo.resolveFeedback(request())).rejects.toBe(error);
    expect(h.db.query).not.toHaveBeenCalled();
  });
  it("typed request getter failure propagates before host; not an HTTP validator", async () => {
    const h = harness(factory);
    const error = new Error("request getter failure");
    const r = Object.defineProperty(request(), "questionId", { get: () => { throw error; } });
    await expect(h.repo.resolveFeedback(r)).rejects.toBe(error);
    expect(h.host.resolvePostAttemptBinding).not.toHaveBeenCalled();
    expect(h.db.query).not.toHaveBeenCalled();
  });
  it("captures caller identity before await and gives host a separate nested source", async () => {
    const h = harness(factory);
    const r = request();
    h.host.resolvePostAttemptBinding = async received => {
      expect(received).not.toBe(r);
      expect(received.source).not.toBe(r.source);
      received.source.page = 900;
      received.questionId = uuid(90);
      r.source.file = "caller-substitution.pdf";
      r.attemptId = uuid(90);
      return h.b;
    };
    expect(await h.repo.resolveFeedback(r)).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    expect(h.db.query).toHaveBeenCalledOnce();
  });
  it("clones binding JSON before SQL can mutate host-owned references", async () => {
    const h = harness(factory);
    h.db.controls.beforeRead = () => {
      (h.b.revisionBlocks as { content: { text: string } }[])[1]!.content.text = "MUTATED HOST PAYLOAD";
      h.b.sourceRefs = [];
      h.b.blockOrder = [];
    };
    expect(await h.repo.resolveFeedback(request())).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
  });
  it("detects same-version current payload changes after host resolution, before SQL evaluation", async () => {
    const h = harness(factory);
    h.db.controls.beforeRead = () => {
      (h.db.stored.current.revisionBlocks as { content: { text: string } }[])[1]!.content.text = "EDITED DURING AWAIT";
    };
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it("detaches each snapshot from rows and caller changes; no cached reusable authority", async () => {
    const h = harness(factory);
    const row = { answer: SAVED_ANSWER };
    h.db.controls.rows = [row];
    const first = await h.repo.resolveFeedback(request());
    row.answer = "LATER ROW TEXT";
    expect(first).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    first!.answer = "CALLER POLLUTION";
    row.answer = SAVED_ANSWER;
    expect(await h.repo.resolveFeedback(request())).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    h.db.stored.excluded = true;
    expect(await h.repo.resolveFeedback(request())).toBeNull();
    expect(h.db.query).toHaveBeenCalledTimes(3);
  });
});

// The runner imports the ACTUAL module (private byte-pinned copy).
// It never substitutes a fake resolver. Without a runner these cases do not
// claim mutation coverage; standalone normal suite still exercises the module.
const variant = process.env.MATERIAL_FEEDBACK_MODULE_VARIANT;
const mutationCase = process.env.MATERIAL_FEEDBACK_MUTATION_CASE;
const mutationTest = variant && mutationCase ? it : it.skip;
describe("card3 actual-module matchedcontrol / assertmutant", () => {
  mutationTest(`${variant ?? "unconfigured"} ${mutationCase ?? "no mutant selected"}`, async () => {
    const target = process.env.MATERIAL_FEEDBACK_MODULE_TARGET;
    if (!target) throw new Error("Private actual-module target required");
    const loaded: unknown = await import(/* @vite-ignore */ target);
    const changedFactory = (loaded as { createOpeningMaterialFeedbackSnapshotRepository: RepositoryFactory }).createOpeningMaterialFeedbackSnapshotRepository;
    const h = harness(changedFactory);
    expect(await h.repo.resolveFeedback(request())).toStrictEqual({ postAttemptNotes: null, answer: SAVED_ANSWER });
    if (mutationCase === "submission-guard") h.db.stored.attempt.submittedAt = null;
    else if (mutationCase === "sha-guard") h.db.stored.current.sourceSha256 = "f".repeat(64);
    else throw new Error("Unknown mutation case");
    const result = await h.repo.resolveFeedback(request());
    expect(result).toBeNull();
    expect(present(result).status).toBe("unavailable");
  });
});
