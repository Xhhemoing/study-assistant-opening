import { describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createOpeningExperimentalBktSnapshotRepository, openingExperimentalBktHeadsQuery, openingExperimentalBktHeldOutQuery,
  projectOpeningExperimentalBktSnapshot, type ExperimentalBktSnapshotInput } from "./opening-experimental-bkt-snapshot";

type Row = Record<string, unknown>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const input: ExperimentalBktSnapshotInput = { courseId: id(3), requirementKey: "span:linear-combination:v1",
  problemId: id(4), itemVersionId: id(5), cutoff: "2026-11-11T07:00:00.000Z" };
const attempted = "2026-11-10T07:00:00.000Z", recorded = "2026-11-10T07:01:00.000Z";
const spec = (problemId = "span-independent-3d", familyId = "span:inconsistent-3d") => ({ kind: "span", specVersion: "span-v1",
  problemId, version: 1, familyId, requirementKey: input.requirementKey });
const context = () => ({ workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: input.courseId,
  data_as_of: "2026-11-11T07:05:00.000Z", snapshot_token: "100:100:", revision: "9" });
const target = () => ({ id: input.itemVersionId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
  course_id: input.courseId, problem_id: input.problemId, target_current: true, target_created_at: attempted,
  spec_metadata: spec("span-example-2d", "span:independent-2d") });
function head(n = 10): Row {
  return { id: id(n), workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: input.courseId,
    requirement_key: input.requirementKey, skill_label: "span", problem_id: id(n + 100), item_version_id: id(n + 200), attempt_id: id(n + 300),
    submitted_at: attempted, recorded_at: recorded, attempt_started_at: attempted, item_created_at: attempted,
    outcome: "correct", assistance: "independent", verdict_source: "deterministic", revision_kind: "original",
    root_observation_id: null, revises_observation_id: null, workspace_history_revision: "8", effective_head_id: id(n),
    attempt_problem_id: id(n + 100), attempt_item_version_id: id(n + 200), attempt_requirement_key: input.requirementKey,
    attempt_submitted_at: attempted, attempt_observation_id: id(n), item_problem_id: id(n + 100), head_observation_id: id(n),
    head_revision: "8", input_revision: "9", policy_version: evaluateEvidenceEligibility({}, {}).policyVersion,
    independent_attempt: "yes", verified_correct: "yes", usable_for_current_version: "yes", reason_codes: ["deterministic_correct", "version_exact"],
    version_applicability: "exact", item_matches: true,
    spec_metadata: n === 10 ? spec() : spec("span-faded-3d", "span:consistent-3d"), sources_current: true, item_current: true,
    has_course_help: false, answer_conditions: false, has_ai: false, has_conflicting_history: false, source_ids: [id(900)], source_versions: { [id(900)]: 1 } };
}
const project = (rows: Row[], patch: Partial<ExperimentalBktSnapshotInput> = {}) =>
  projectOpeningExperimentalBktSnapshot(scope, { ...input, ...patch }, context(), target(), rows);

/** Typed postgres.js boundary fake, NOT a SQL executor or PostgreSQL test. */
function fake(batches: Row[][] = []) {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const beginModes: string[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?"), values });
    return Promise.resolve(batches.shift() ?? []);
  };
  const tx = tag as unknown as TransactionSql;
  const sql = Object.assign(tag, { begin: async (mode: string, callback: (transaction: TransactionSql) => Promise<unknown>) => {
    beginModes.push(mode); return callback(tx);
  } }) as unknown as Sql;
  return { sql, tx, queries, beginModes };
}

describe("experimental BKT metadata snapshot (typed SQL fake only; no PG)", () => {
  it("executes real parameterized queries within one owned read-only repeatable snapshot", async () => {
    const db = fake([[context()], [target()], [head()]]);
    const result = await createOpeningExperimentalBktSnapshotRepository(db.sql).read(scope, input);
    expect(db.beginModes).toEqual(["isolation level repeatable read read only"]);
    expect(db.queries).toHaveLength(3);
    expect(db.queries[0]!.values).toContain(scope.ownerUserId);
    expect(db.queries[2]!.values).toEqual([scope.workspaceId, scope.ownerUserId, input.courseId, input.requirementKey]);
    expect(result).toMatchObject({ status: "available", scope: { ...scope, courseId: input.courseId },
      stateVersion: "bkt-read:100:100::9:2026-11-11T07:05:00.000Z", cutoff: input.cutoff });
    expect(result.features).toHaveLength(1);
    expect(result.observationHeads).toEqual([expect.objectContaining({ id: id(10), problemId: id(110), itemVersionId: id(210) })]);
    expect(result.families).toEqual([{ observationId: id(10), familyId: "span:inconsistent-3d", provenance: "span_catalogue" }]);
    expect(result.features[0]!.transfer).toMatchObject({ usable: "unknown", knowledgeComponents: [] });
    expect(result.features[0]!.sourceVersions).toEqual({ [id(900)]: 1 });
  });

  it("builds only metadata SQL with scoped joins, without reading answer/body or mutating projections", async () => {
    const db = fake();
    await openingExperimentalBktHeadsQuery(db.tx, scope, input);
    const query = db.queries[0]!.text;
    expect(query).toContain("root.effective_head_id");
    expect(query).toContain("p.source_states=COALESCE(live.states");
    expect(query).toContain("opening_privacy_exclusions");
    expect(query).toContain("opening_study_intent_events");
    expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE)\b/i);
    expect(query).not.toMatch(/\b\w+\.answer\b|\b\w+\.\*|source_body|body_text|SELECT\s+\*/i);
    expect(query).not.toContain("v.evaluation_spec AS");
    expect(query).not.toContain(input.courseId);
  });

  it("preserves qualified negative outcomes without creating multi-KC copies", () => {
    const result = project([{ ...head(), outcome: "incorrect", verified_correct: "no", reason_codes: ["deterministic_incorrect", "version_exact"] }]);
    expect(result.status).toBe("available");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]!.eligibility.verifiedCorrect).toBe("no");
    expect(result.observationHeads[0]!.verifiedCorrect).toBe("no");
    expect(result.features[0]!.transfer.knowledgeComponents).toEqual([]);
  });

  it.each([
    ["other owner", { owner_user_id: id(99) }], ["other workspace", { workspace_id: id(99) }],
    ["other course", { course_id: id(99) }], ["other requirement", { requirement_key: "another" }],
    ["wrong attempt", { attempt_observation_id: id(99) }], ["wrong item", { item_problem_id: id(99) }],
    ["wrong attempt requirement", { attempt_requirement_key: "another" }], ["wrong attempt time", { attempt_submitted_at: recorded }],
    ["not effective", { effective_head_id: id(99) }], ["retracted", { revision_kind: "retract" }],
    ["revised", { root_observation_id: id(99), revises_observation_id: id(98), revision_kind: "check" }],
    ["history conflict", { has_conflicting_history: true }],
    ["missing qualification", { head_observation_id: null }], ["stale revision", { input_revision: "8" }],
    ["old policy", { policy_version: "opening-evidence-v1" }], ["head revision conflict", { head_revision: "7" }],
    ["missing revision", { head_revision: null, workspace_history_revision: null }],
    ["zero revision", { head_revision: "0", workspace_history_revision: "0" }],
    ["future revision", { head_revision: "10", workspace_history_revision: "10" }],
    ["privacy or version changed", { sources_current: false }], ["item changed", { item_current: false }],
    ["item not matched", { item_matches: false }], ["version unknown", { version_applicability: "version_unknown" }],
    ["AI verdict", { verdict_source: "ai_graded" }], ["AI payload present", { has_ai: true }],
    ["AI reasons", { reason_codes: ["ai_graded_correct"] }], ["missing reasons", { reason_codes: null }],
    ["help delivered", { has_course_help: true }], ["help unknown", { has_course_help: null }],
    ["copied or guess", { answer_conditions: true }], ["hinted", { assistance: "hinted" }],
    ["not independent", { independent_attempt: "no" }], ["independence unknown", { independent_attempt: "unknown" }],
    ["not current", { usable_for_current_version: "unknown" }], ["correctness unknown", { verified_correct: "unknown" }],
    ["outcome conflicts", { outcome: "incorrect" }], ["source version missing", { source_versions: {} }],
    ["source version invalid", { source_versions: { [id(900)]: "1" } }],
    ["missing family", { spec_metadata: { ...spec(), familyId: null } }],
    ["invented family", { spec_metadata: { ...spec(), familyId: id(900) } }],
    ["noncanonical problem", { spec_metadata: { ...spec(), problemId: "not-in-catalogue" } }],
    ["unknown format", { spec_metadata: { ...spec(), kind: "generic" } }],
  ] satisfies Array<[string, Row]>)("excludes %s", (_label, patch) => {
    const result = project([{ ...head(), ...patch }]);
    expect(result.status).toBe("not_available");
    expect(result.features).toEqual([]);
    expect(result.observationHeads).toEqual([]);
    expect(Object.values(result.excluded)).toEqual([1]);
  });

  it.each([
    { recorded_at: null }, { submitted_at: null }, { recorded_at: input.cutoff }, { submitted_at: input.cutoff },
    { recorded_at: "2026-11-12T00:00:00Z" }, { recorded_at: "2026-11-09T00:00:00Z" },
    { recorded_at: "2026-02-30T00:00:00Z" }, { submitted_at: "2026-11-10T07:00:00" },
    { attempt_started_at: recorded }, { item_created_at: recorded },
  ])("requires strict attempted/recorded cutoffs and coherent item/attempt time: %o", patch => {
    const result = project([{ ...head(), ...patch,
      ...(Object.hasOwn(patch, "submitted_at") ? { attempt_submitted_at: patch.submitted_at } : {}) }]);
    expect(result.status).toBe("not_available");
    expect(result.excluded).toEqual({ dual_time_unavailable: 1 });
  });

  it("allows attempted = recorded only when strictly before cutoff", () => {
    expect(project([{ ...head(), recorded_at: attempted }]).status).toBe("available");
  });

  it.each(["id", "attempt_id", "problem_id"])("poisons all duplicated %s identities, including contradictory copies", key => {
    const a = head(), b = { ...head(20), [key]: a[key], outcome: "incorrect", verified_correct: "no" };
    expect(project([a, b]).features).toEqual([]);
    expect(project([b, a]).features).toEqual([]);
  });

  it("rejects the same canonical problem under distinct database UUIDs and requirements", () => {
    const result = project([head(), { ...head(20), spec_metadata: spec() }]);
    expect(result.features).toEqual([]);
    expect(result.excluded).toEqual({ canonical_problem_conflict: 2 });
  });

  it("excludes target family, explicit problem/observation held-outs; never uses source ID as family", () => {
    expect(project([head()], { excludedProblemIds: [id(110)] }).features).toEqual([]);
    expect(project([head()], { excludedProblemIds: [id(10)] }).features).toEqual([]);
    expect(project([{ ...head(), spec_metadata: target().spec_metadata }]).features).toEqual([]);
    const missingFamily = { ...head(), spec_metadata: { ...spec(), familyId: null } };
    expect(project([missingFamily]).excluded).toEqual({ canonical_family_unavailable: 1 });
  });

  it("does not hide one row's exclusion by claiming no data, or discard another admissible row", () => {
    const result = project([head(), { ...head(20), has_ai: true }]);
    expect(result.status).toBe("available");
    expect(result.features.map(row => row.observationId)).toEqual([id(10)]);
    expect(result.excluded).toEqual({ non_deterministic_or_ai: 1 });
    expect(project([])).toMatchObject({ status: "not_available", reason: "no_qualified_heads", features: [] });
  });

  it.each([
    { revision: null }, { revision: "9007199254740992" }, { workspace_id: id(99) }, { owner_user_id: id(99) },
    { course_id: id(99) }, { data_as_of: "invalid" }, { snapshot_token: null },
  ])("fails closed on invalid or cross-scope snapshot %o", patch => {
    expect(projectOpeningExperimentalBktSnapshot(scope, input, { ...context(), ...patch }, target(), [head()]))
      .toMatchObject({ status: "not_available", reason: "snapshot_unavailable", features: [], observationHeads: [] });
  });

  it.each([{ target_current: false }, { target_created_at: "2026-11-12T00:00:00Z" },
    { target_created_at: null }, { owner_user_id: id(99) }, { problem_id: id(99) }])("rejects stale/unprovable target metadata %o", patch => {
    expect(projectOpeningExperimentalBktSnapshot(scope, input, context(), { ...target(), ...patch }, [head()]))
      .toMatchObject({ status: "not_available", reason: "canonical_target_family_unavailable", features: [] });
  });

  it("does not silently use future cutoff or invent missing target family", () => {
    expect(project([head()], { cutoff: "2026-11-12T00:00:00Z" }).status).toBe("not_available");
    expect(projectOpeningExperimentalBktSnapshot(scope, input, context(), { ...target(), spec_metadata: null }, [head()]))
      .toMatchObject({ status: "not_available", reason: "canonical_target_family_unavailable", features: [] });
  });

  it("invalid input never queries rows; unauthorized/missing scope never queries target or heads", async () => {
    const invalid = fake();
    expect((await createOpeningExperimentalBktSnapshotRepository(invalid.sql).read(scope, { ...input, courseId: "bad" })).reason).toBe("invalid_input");
    expect(invalid.queries).toEqual([]);
    const absent = fake([[]]);
    expect((await createOpeningExperimentalBktSnapshotRepository(absent.sql).read(scope, input)).reason).toBe("snapshot_unavailable");
    expect(absent.queries).toHaveLength(1);
  });

  it("propagates DB failures rather than pretending the query succeeded empty", async () => {
    const failure = new Error("SQL unavailable");
    const sql = { begin: () => Promise.reject(failure) } as unknown as Sql;
    await expect(createOpeningExperimentalBktSnapshotRepository(sql).read(scope, input)).rejects.toBe(failure);
  });
});

function heldOut(heldOutId: string, patch: Row = {}): Row {
  return { held_out_id: heldOutId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, course_id: input.courseId,
    problem_id: id(110), item_version_id: id(210), requirement_key: input.requirementKey,
    item_created_at: attempted, resolver_current: true, spec_metadata: spec(), ...patch };
}
function sibling(): Row {
  return { ...head(20), spec_metadata: spec("span-reserved-20261021-q03", "span:inconsistent-3d") };
}
function resolved(rows: Row[], heldOutIds: string[], bindings: Row[]) {
  return projectOpeningExperimentalBktSnapshot(scope, { ...input, excludedProblemIds: heldOutIds }, context(), target(), rows, bindings);
}

describe("R2 trusted held-out family resolution (no PG)", () => {
  it("control: distinct canonical questions in a non-target family are not duplicate poison", () => {
    expect(project([head(), sibling()]).features).toHaveLength(2);
  });

  // Original independent P1 counterexamples: observation UUID and problem UUID.
  it.each([id(110), id(10)])("excludes both canonical siblings for held-out %s", heldOutId => {
    const result = resolved([head(), sibling()], [heldOutId], [heldOut(heldOutId)]);
    expect(result.features).toEqual([]);
    expect(result.observationHeads).toEqual([]);
    expect(result.status).toBe("not_available");
    expect(result.excluded).toEqual({ held_out_or_target_family: 2 });
  });

  it.each([id(110), id(10)])("resolves %s when held-out is outside requirement and not an effective returned head", async heldOutId => {
    const otherRequirement = "span:other-confirmed-requirement";
    const binding = heldOut(heldOutId, { requirement_key: otherRequirement,
      spec_metadata: { ...spec(), requirementKey: otherRequirement } });
    const db = fake([[context()], [target()], [binding], [sibling()]]);
    const result = await createOpeningExperimentalBktSnapshotRepository(db.sql).read(scope, { ...input, excludedProblemIds: [heldOutId] });
    expect(result.features).toEqual([]);
    expect(result.excluded).toEqual({ held_out_or_target_family: 1 });
    expect(db.beginModes).toEqual(["isolation level repeatable read read only"]);
    expect(db.queries).toHaveLength(4);
    const lookup = db.queries[2]!;
    expect(lookup.values).toEqual([scope.workspaceId, scope.ownerUserId, input.courseId, [heldOutId],
      scope.workspaceId, scope.ownerUserId, input.courseId, [heldOutId], scope.workspaceId, scope.ownerUserId, input.courseId]);
    expect(lookup.text).not.toMatch(/effective_head_id|revision_kind|o\.requirement_key\s*=/);
    expect(lookup.text).toContain("LEFT JOIN opening_learning_item_versions");
  });

  it.each([{ bindings: [] }, { bindings: [heldOut(id(999))] }])("never ignores unresolved IDs even with eligible sibling rows: %o", ({ bindings }) => {
    const result = resolved([sibling()], [id(10)], bindings);
    expect(result).toMatchObject({ status: "not_available", reason: "held_out_family_unavailable", features: [], observationHeads: [] });
  });

  it.each([
    { owner_user_id: id(99) }, { workspace_id: id(99) }, { course_id: id(99) },
    { resolver_current: false }, { resolver_current: null }, { item_version_id: null }, { problem_id: null },
    { requirement_key: null }, { item_created_at: null }, { item_created_at: "2026-11-12T00:00:00Z" },
    { spec_metadata: null }, { spec_metadata: { ...spec(), familyId: null } },
    { spec_metadata: { ...spec(), familyId: id(900) } }, { spec_metadata: { ...spec(), problemId: "unknown" } },
    { spec_metadata: { ...spec(), requirementKey: "mismatch" } },
  ])("fails closed on unknown/stale/cross-owner held-out metadata %o", patch => {
    expect(resolved([sibling()], [id(10)], [heldOut(id(10), patch)]))
      .toMatchObject({ status: "not_available", reason: "held_out_family_unavailable", features: [] });
  });

  it("rejects conflicting or partly unprovable bindings instead of accepting the first valid family", () => {
    for (const other of [heldOut(id(10), { spec_metadata: spec("span-faded-3d", "span:consistent-3d") }),
      heldOut(id(10), { resolver_current: false }), heldOut(id(10), { spec_metadata: null })]) {
      for (const bindings of [[heldOut(id(10)), other], [other, heldOut(id(10))]]) {
        expect(resolved([sibling()], [id(10)], bindings).reason).toBe("held_out_family_unavailable");
      }
    }
  });

  it("requires every distinct held-out ID, deduplicates identical IDs and accepts consistent multiple bindings", () => {
    expect(resolved([sibling()], [id(10), id(99)], [heldOut(id(10))]).reason).toBe("held_out_family_unavailable");
    expect(resolved([sibling()], [id(10), id(10)], [heldOut(id(10)), heldOut(id(10))]).excluded)
      .toEqual({ held_out_or_target_family: 1 });
  });

  it("does not exclude another proven family or trust an arbitrary client family claim", () => {
    const result = resolved([head(20)], [id(10)], [heldOut(id(10))]);
    expect(result.status).toBe("available");
    expect(result.features.map(row => row.observationId)).toEqual([id(20)]);
    const attackInput = { ...input, excludedProblemIds: [id(10)], excludedFamilyIds: ["span:consistent-3d"] };
    expect(projectOpeningExperimentalBktSnapshot(scope, attackInput, context(), target(), [head(20)]).reason)
      .toBe("held_out_family_unavailable");
  });

  it("invalid held-out IDs never reach SQL, and missing/foreign IDs never reach head querying", async () => {
    for (const excludedProblemIds of [["not-uuid"], ["span:inconsistent-3d"], null, "bad"]) {
      const db = fake();
      const bad = { ...input, excludedProblemIds } as unknown as ExperimentalBktSnapshotInput;
      expect((await createOpeningExperimentalBktSnapshotRepository(db.sql).read(scope, bad)).reason).toBe("invalid_input");
      expect(db.queries).toEqual([]);
    }
    const missing = fake([[context()], [target()], []]);
    expect((await createOpeningExperimentalBktSnapshotRepository(missing.sql).read(scope, { ...input, excludedProblemIds: [id(999)] })).reason)
      .toBe("held_out_family_unavailable");
    expect(missing.queries).toHaveLength(3);
  });

  it("builds scoped parameterized metadata SQL without answer/body reads or client family inputs", async () => {
    const db = fake();
    await openingExperimentalBktHeldOutQuery(db.tx, scope, { ...input, excludedProblemIds: [id(10), id(10)] });
    const query = db.queries[0]!;
    expect(query.values.filter(Array.isArray)).toEqual([[id(10)], [id(10)]]);
    expect(query.text).not.toContain(id(10));
    expect(query.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b|\b\w+\.answer\b|\b\w+\.\*|source_body|body_text|SELECT\s+\*/i);
    expect(query.text).toContain("opening_privacy_exclusions");
    expect(query.text).not.toContain("effective_head_id");
  });
});
