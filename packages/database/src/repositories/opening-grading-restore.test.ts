import { describe, expect, it } from "vitest";
import { restoreOpeningGradingMetadata } from "./opening-grading-restore";
import { normalizeOpeningImportedEvaluation } from "./opening-backup-evaluation";

const ws = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const root = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const revision = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const graded = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const source = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const owner = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const photo = { id: source, version: 1, physicalPage: 1 };
const legacyKey = (id: string) => `ai-grade:${ws}:${id}`;
const key = (ordinal: number) => `ai-grade:${ws}:${root}:${ordinal}`;
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, workspace_id: ws, owner_user_id: owner,
  root_observation_id: root, revises_observation_id: null, answer: "1", source_ids: [source], source_versions: { [source]: 1 }, ...extra });
const aiIntent = (id: string) => ({ aiGrading: { input: { observationId: id } } });

describe("grading metadata restore without paid queue replay", () => {
  it("preserves current revision/key and sealed photo but still strips scoring authority", () => {
    const rows = [row(root, { answer_revision: 1, grading_operation_id: key(1), effective_head_id: graded }),
      row(revision, { answer: "2", revises_observation_id: root, answer_revision: 2, grading_operation_id: key(2), grading_work_source: photo }),
      row(graded, { answer: "2", revises_observation_id: revision, answer_revision: 2, grading_operation_id: key(2),
        grading_work_source: photo, verdict_source: "ai_graded", ai_evaluation: { outcome: "correct", workSource: photo } })];
    const result = restoreOpeningGradingMetadata(rows, ws, owner);
    expect(result[1]).toMatchObject({ answer_revision: 2, grading_work_source: photo, grading_operation_id: key(2) });
    expect(normalizeOpeningImportedEvaluation("opening_learning_observations", result[2]!))
      .toMatchObject({ ai_evaluation: null, verdict_source: "unknown", outcome: "unverified", answer_revision: 2, grading_work_source: photo });
  });

  it("preserves deterministic grading metadata without restoring its scoring authority", () => {
    const [restored] = restoreOpeningGradingMetadata([row(root, { answer_revision: 1, grading_operation_id: key(1),
      verdict_source: "deterministic", server_evaluation: { outcome: "correct" }, grading_work_source: photo })], ws);
    expect(normalizeOpeningImportedEvaluation("opening_learning_observations", restored!)).toMatchObject({
      answer_revision: 1, grading_operation_id: key(1), grading_work_source: photo, server_evaluation: null,
      verdict_source: "unknown", outcome: "unverified", evidence_verdict: "MASTERY_NOT_ESTABLISHED",
    });
  });

  it("derives legacy chains irrespective of input order and inherits earlier answer photos and spent AI keys", () => {
    const rows = [row(revision, { answer: "2", revises_observation_id: graded }), row(root),
      row(graded, { revises_observation_id: root, submitted_intent: aiIntent(root), ai_evaluation: { workSource: photo } })];
    const original = structuredClone(rows);
    const result = restoreOpeningGradingMetadata(rows, ws);
    expect(result.map(value => value.answer_revision)).toEqual([2, 1, 1]);
    expect(result[0]).toMatchObject({ grading_work_source: photo, grading_operation_id: legacyKey(revision) });
    expect(result[2]).toMatchObject({ grading_work_source: photo, grading_operation_id: legacyKey(root) });
    expect(rows).toEqual(original);
  });

  it.each(["replace", "retract"])("retains unchanged manual %s on a legacy paid key, without AI authority", revisionKind => {
    const rows = [row(root, { answer_revision: 1, grading_operation_id: legacyKey(root), grading_work_source: photo }),
      row(revision, { revises_observation_id: root, revision_kind: revisionKind, answer_revision: 1,
        grading_operation_id: legacyKey(root), verdict_source: "self_report", outcome: "incorrect" })];
    expect(restoreOpeningGradingMetadata(rows, ws)[1]).toMatchObject({ answer_revision: 1,
      grading_operation_id: legacyKey(root), grading_work_source: photo, verdict_source: "self_report", outcome: "incorrect" });
  });

  it("does not generate a fresh key if an unchanged current manual revision omitted its operation", () => {
    const result = restoreOpeningGradingMetadata([row(root, { answer_revision: 1, grading_operation_id: key(1) }),
      row(revision, { revises_observation_id: root, answer_revision: 1 })], ws);
    expect(result[1]?.grading_operation_id).toBe(key(1));
  });

  it("preserves 0093 legacy manual ordinals and keys rather than rewriting historic paid identity", () => {
    const result = restoreOpeningGradingMetadata([row(root), row(revision, { revises_observation_id: root }),
      row(graded, { revises_observation_id: revision, submitted_intent: aiIntent(revision), ai_evaluation: { workSource: photo } })], ws);
    expect(result.map(value => value.answer_revision)).toEqual([1, 2, 2]);
    expect(result.map(value => value.grading_operation_id)).toEqual([legacyKey(root), legacyKey(revision), legacyKey(revision)]);
  });

  it("recognizes a downgraded AI revision's saved input when legacy metadata is absent", () => {
    const result = restoreOpeningGradingMetadata([row(root), row(graded, {
      revises_observation_id: root, submitted_intent: aiIntent(root), ai_evaluation: null, verdict_source: "unknown",
    })], ws);
    expect(result[1]).toMatchObject({ answer_revision: 1, grading_operation_id: legacyKey(root) });
  });

  it("accepts a legacy original without revision links", () => {
    expect(restoreOpeningGradingMetadata([row(root, { root_observation_id: null, revision_kind: null })], ws)[0])
      .toMatchObject({ answer_revision: 1, grading_operation_id: legacyKey(root), grading_work_source: null });
  });

  it.each([legacyKey(revision), key(1)])("does not change an inherited paid key to %s on the same answer revision", operation => {
    expect(() => restoreOpeningGradingMetadata([row(root, { grading_operation_id: legacyKey(root) }),
      row(revision, { revises_observation_id: root, answer_revision: 1, grading_operation_id: operation })], ws)).toThrow(/identity/);
  });

  it("does not rebind a payment key to another answer or source", () => {
    expect(() => restoreOpeningGradingMetadata([row(root, { grading_operation_id: `ai-grade:${ws}:${revision}:1` })], ws)).toThrow(/identity/);
    expect(() => restoreOpeningGradingMetadata([row(root, { grading_work_source: { ...photo, version: 2 } })], ws)).toThrow(/provenance/);
    expect(() => restoreOpeningGradingMetadata([row(root, { answer_revision: -1 })], ws)).toThrow(/revision/);
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { answer: "2", revises_observation_id: root,
      answer_revision: 1, grading_operation_id: legacyKey(root) })], ws)).toThrow(/answer changed/);
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { answer: "2", revises_observation_id: root,
      answer_revision: 2, grading_operation_id: legacyKey(root) })], ws)).toThrow(/identity/);
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { revises_observation_id: root,
      answer_revision: 2, grading_operation_id: key(2) })], ws)).toThrow(/unchanged answer/);
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { answer: "2", revises_observation_id: root,
      answer_revision: 3 })], ws)).toThrow(/revision/);
  });

  it("rejects adding a photo to an unchanged manual revision", () => {
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, {
      revises_observation_id: root, answer_revision: 1, grading_work_source: photo,
    })], ws)).toThrow(/photo changed/);
  });

  it("rejects swapping a sealed photo page under the same answer revision", () => {
    expect(() => restoreOpeningGradingMetadata([row(root, { grading_work_source: photo }),
      row(revision, { revises_observation_id: root, answer_revision: 1, grading_work_source: { ...photo, physicalPage: 2 } })], ws))
      .toThrow(/photo changed/);
  });

  it("rejects cross-root, cross-owner and foreign-workspace predecessors", () => {
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { root_observation_id: revision,
      revises_observation_id: root, answer_revision: 1 })], ws)).toThrow(/root/);
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { owner_user_id: source,
      revises_observation_id: root, answer_revision: 1 })], ws)).toThrow(/owner/);
    expect(() => restoreOpeningGradingMetadata([row(root, { workspace_id: source })], ws)).toThrow(/workspace/);
    expect(() => restoreOpeningGradingMetadata([row(root, { owner_user_id: source })], ws, owner)).toThrow(/owner/);
  });

  it("rejects foreign AI input and effective-head identities", () => {
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, {
      revises_observation_id: root, submitted_intent: aiIntent(graded),
    })], ws)).toThrow(/input identity/);
    expect(() => restoreOpeningGradingMetadata([row(root, { effective_head_id: revision }),
      row(revision, { root_observation_id: revision })], ws)).toThrow(/head identity/);
  });

  it("rejects incomplete, duplicated or cyclic history instead of inventing a revision", () => {
    expect(() => restoreOpeningGradingMetadata([row(revision, { revises_observation_id: root })], ws)).toThrow(/missing/);
    expect(() => restoreOpeningGradingMetadata([row(root), row(root)], ws)).toThrow(/duplicate/);
    expect(() => restoreOpeningGradingMetadata([row(root, { revises_observation_id: revision }), row(revision, { revises_observation_id: root })], ws)).toThrow(/cycle/);
  });

  it("rejects a fork or an effective head that silently omits later revisions", () => {
    expect(() => restoreOpeningGradingMetadata([row(root), row(revision, { revises_observation_id: root }),
      row(graded, { revises_observation_id: root })], ws)).toThrow(/fork/);
    expect(() => restoreOpeningGradingMetadata([row(root, { effective_head_id: root }),
      row(revision, { revises_observation_id: root })], ws)).toThrow(/head identity/);
  });
});
