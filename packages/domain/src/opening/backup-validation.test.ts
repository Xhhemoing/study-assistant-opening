import { expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { orderBackupMisconceptionRevisions, sourceReferences } from "./backup-validation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const referenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const openRange = '["2026-11-21 12:00:00.000001+00",)';

it.each(["self", "two revisions"])("rejects a %s predecessor cycle during restore preflight", cycle => {
  const a = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", b = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const root = {
    workspace_id: workspaceId, owner_user_id: referenceId, edge_id: referenceId, revision_id: a, prior_revision_id: a,
    status: "verified", origin: "system_diagnosis", course_id: null, privacy_epoch: 0, evidence_attempt_ids: [],
    valid_range: openRange, tx_range: openRange,
  };
  const backup: OpeningBackup = {
    format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [],
    tables: { v3_bitemporal_misconception_edges: cycle === "self"
      ? [root] : [{ ...root, prior_revision_id: b }, { ...root, revision_id: b }] },
  };
  expect(validateOpeningRestore(backup, [])).toMatchObject({
    allowed: false, errors: ["invalid misconception revision lineage"],
  });
});

it.each([
  { name: "a mixed epoch-0 root and epoch-1 correction", epochs: [0, 1] },
  { name: "an epoch-0 root", epochs: [0] },
  { name: "an epoch-2 root", epochs: [2] },
  { name: "a string epoch", epochs: ["1"] },
])("rejects $name in an epoch-1 archive", ({ epochs }) => {
  const root = {
    workspace_id: workspaceId, owner_user_id: referenceId, edge_id: referenceId, revision_id: referenceId,
    status: "verified", origin: "system_diagnosis", course_id: null, evidence_attempt_ids: [],
    privacy_epoch: 1,
    valid_range: openRange, tx_range: openRange,
  };
  const correction = {
    ...root, revision_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", prior_revision_id: root.revision_id,
    status: "learner_reported", origin: "learner_correction", learner_disposition: "clarified",
  };
  const revisions = [root, correction].slice(0, epochs.length);
  const backup: OpeningBackup = {
    format: "opening-backup", version: 1, workspaceId, privacyEpoch: 1, deletionJournal: [], objects: [],
    tables: { v3_bitemporal_misconception_edges: revisions },
  };
  expect(validateOpeningRestore(backup, [])).toMatchObject({ allowed: true, errors: [] });
  backup.tables.v3_bitemporal_misconception_edges = revisions.map((row, index) => ({ ...row, privacy_epoch: epochs[index] }));
  expect(validateOpeningRestore(backup, [])).toMatchObject({
    allowed: false, errors: ["misconception revision privacy epoch does not match the archive epoch"],
  });
});

it.each([
  [undefined, false],
  ["", false],
  ["empty", false],
  ["(2026-11-21T12:00:00Z,)", false],
  ["[2026-11-21T12:00:00Z,2026-11-22T12:00:00Z]", false],
  ["[,2026-11-21T12:00:00Z)", false],
  ["[-infinity,)", false],
  ["[2026-11-21T12:00:00Z,infinity)", false],
  ['["2026-02-30 12:00:00+00",)', false],
  ['["2026-11-21 12:00:00",)', false],
  ['["2026-11-21 12:00:00.000002+00","2026-11-21 12:00:00.000001+00")', false],
  ['["2026-11-21 12:00:00+01","2026-11-21 11:00:00+00")', false],
  ['["2026-11-21 12:00:00+00",)', true],
  ['["2026-11-21 12:00:00.000001+01","2026-11-21 11:00:00.000002+00")', true],
  ["[2026-11-21T12:00:00Z,2026-11-22T12:00:00Z)", true],
  ['["4714-11-24 04:36:48+04:36:48 BC","4714-11-24 04:36:48.000001+04:36:48 BC")', true],
  ['["294277-01-01 04:29:59.999998+04:30","294277-01-01 04:29:59.999999+04:30")', true],
  ['["294277-01-01 00:00:00+00",)', false],
])("validates an archived time range %j (allowed: %s)", (range, allowed) => {
  const root = {
    workspace_id: workspaceId, owner_user_id: referenceId, edge_id: referenceId, revision_id: referenceId,
    status: "verified", origin: "system_diagnosis", course_id: null, privacy_epoch: 0, evidence_attempt_ids: [],
    valid_range: openRange, tx_range: openRange,
  };
  for (const column of ["valid_range", "tx_range"]) {
    const backup: OpeningBackup = {
      format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [],
      tables: { v3_bitemporal_misconception_edges: [{ ...root, [column]: range }] },
    };
    const result = validateOpeningRestore(backup, []);
    expect(result.allowed).toBe(allowed);
    expect(result.errors).toEqual(allowed ? [] : [`misconception revision has invalid ${column}`]);
  }
});

it("requires the same normalized course across every revision of a misconception edge", () => {
  const course = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const root = {
    workspace_id: workspaceId, owner_user_id: referenceId, edge_id: referenceId, revision_id: referenceId, course_id: course,
  };
  const correction = {
    ...root, revision_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", prior_revision_id: root.revision_id,
    course_id: course.toUpperCase(),
  };
  expect(orderBackupMisconceptionRevisions([correction, root])).toEqual([root, correction]);
  expect(orderBackupMisconceptionRevisions([{ ...correction, course_id: null }, root])).toBeNull();
  expect(orderBackupMisconceptionRevisions([root, { ...correction, course_id: referenceId }])).toBeNull();
  expect(orderBackupMisconceptionRevisions([root, { ...correction, prior_revision_id: null, course_id: null }])).toBeNull();
});

it.each(["library_blocks", "library_revisions"])("checks only typed block citations in %s", table => {
  const documentId = "33333333-3333-4333-8333-333333333333";
  const id = "44444444-4444-4444-8444-444444444444";
  const block = { id, type: "text", position: 0, content: {
    meta: { sourceId: "external-reference", referenceSourceId: referenceId },
  } };
  const row = { id, document_id: documentId, workspace_id: workspaceId };
  const archive: OpeningBackup = { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
    deletionJournal: [], objects: [], tables: { library_documents: [{ id: documentId, workspace_id: workspaceId }] } };
  const currentJournal = [{ sourceId: referenceId, deletedAt: "2026-09-28T00:00:00.000Z" }];
  const addBlock = (content: Record<string, unknown>) => {
    archive.tables[table] = [table === "library_blocks" ? { ...row, content } : { ...row, blocks: [{ ...block, content }] }];
  };
  addBlock({ ...block.content, citationBinding: { refs: ["external-reference"] } });
  expect(validateOpeningRestore(archive, currentJournal)).toMatchObject({ allowed: true, errors: [] });

  const citationBinding = { blockId: id, role: "teach", status: "bound", factualSupport: "unverified",
    refs: [{ sourceId: referenceId.toUpperCase(), sourceVersion: 1, chunkId: id, page: null }] };
  addBlock({ ...block.content, citationBinding });
  expect(validateOpeningRestore(archive, []).errors).toContain(`table ${table} references a source missing from the backup`);
  expect(validateOpeningRestore(archive, currentJournal).errors).toContain(`table ${table} references a deleted source`);
  addBlock({ ...block.content, citationBinding: { ...citationBinding, refs: [{ sourceId: "external-reference", sourceVersion: 1 }] } });
  expect(validateOpeningRestore(archive, []).errors).toContain(`table ${table} has invalid source lineage`);
});

it("rejects restoring a historical check whose only source link is reference_check.referenceId", () => {
  const archive: OpeningBackup = {
    format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0,
    deletionJournal: [], objects: [], tables: {
      opening_learning_observations: [{ workspace_id: workspaceId, source_ids: [], reference_source_id: null,
        reference_check: { referenceId: referenceId.toUpperCase() } }],
    },
  };
  expect(validateOpeningRestore(archive, [{ sourceId: referenceId, deletedAt: "2026-09-28T00:00:00.000Z" }]).errors)
    .toContain("table opening_learning_observations references a deleted source");
});

it("collects an owned reference check source without changing the saved fact", () => {
  const row = { reference_check: { referenceId: referenceId.toUpperCase(), method: "Compare every step" } };
  const before = structuredClone(row);
  expect(sourceReferences(row)).toEqual([referenceId]);
  expect(row).toEqual(before);
});

it.each([{}, { referenceId: null }, { referenceId: "not-a-source" }, [], "invalid"].map(reference_check => ({ reference_check })))(
  "rejects malformed check provenance at the archive boundary: $reference_check", ({ reference_check }) => {
    expect(sourceReferences({ reference_check })).toBeNull();
  },
);

it("keeps legacy null checks and unrelated referenceId documents compatible", () => {
  expect(sourceReferences({ reference_check: null })).toEqual([]);
  expect(sourceReferences({})).toEqual([]);
  expect(sourceReferences({ payload: { referenceId: "non-source-business-reference" } })).toEqual([]);
});

it("accepts source-free question lineage only for question tables and retains malformed-source rejection", () => {
  const row = { workspace_id: workspaceId, source_id: null, source_version: null, stem_snapshot: "17 × 23" };
  const backup = (table: string, question: Record<string, unknown> = row): OpeningBackup => ({ format: "opening-backup", version: 1,
    workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [], tables: { [table]: [question] } });
  for (const table of ["opening_problem_refs", "opening_learning_item_versions"]) {
    expect(validateOpeningRestore(backup(table), []).allowed).toBe(true);
    expect(validateOpeningRestore(backup(table, { ...row, source_id: "invalid" }), []).allowed).toBe(false);
  }
  expect(validateOpeningRestore(backup("opening_source_chunks"), []).allowed).toBe(false);
  expect(sourceReferences(row)).toBeNull();
});
