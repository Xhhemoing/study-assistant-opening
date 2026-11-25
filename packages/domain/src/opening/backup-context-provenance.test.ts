import { describe, expect, it } from "vitest";
import {
  parseBackupSourceRefs,
} from "../../../database/src/repositories/backup-publication-provenance";
import {
  projectOpeningBackupCardSources,
  projectOpeningBackupProvenance,
} from "../../../database/src/repositories/opening-backup-library";
import {
  containsDisallowedNoteMetadataOrArray as dbContainsDisallowedNoteMetadataOrArray,
  parseContextSourceRefs,
  parseNoteContextProvenanceRefs,
  parseNoteContextSourceRefs,
} from "../../../database/src/repositories/opening-context-provenance";
import { planOpeningRestoreApply } from "./backup-apply-plan";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";
import { projectPrivacyGuardedOpeningDataset } from "./deidentified-dataset";
import {
  containsDisallowedNoteMetadataOrArray,
  noteProvenanceSourceReferences,
  sourceReferences,
  turnMemoryDependencyIds,
  turnSourceReferences,
} from "./backup-validation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerId = "33333333-3333-4333-8333-333333333333";
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherSourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const turnId = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";
const candidateId = "66666666-6666-4666-8666-666666666666";
const mark = { sourceId, deletedAt: "2026-09-29T00:00:00.000Z" };
const currentMemoryDeletions = { workspaceId, memories: [] };
const row = (fields: Record<string, unknown>) => ({ workspace_id: workspaceId, ...fields });
const turn = (fields: Record<string, unknown>) => row({
  id: turnId, conversation_id: conversationId, role: "assistant", source_ids: [], citations: [], source_versions: {},
  ...fields,
});
function backup(turns: Record<string, unknown>[]): OpeningBackup {
  return { format: "opening-backup", version: 1, workspaceId, privacyEpoch: 0, deletionJournal: [], objects: [],
    tables: { opening_turns: turns, opening_conversations: [row({ id: conversationId, owner_user_id: ownerId })] } };
}

describe("context provenance at the backup boundary", () => {
  it("collects every context source version with normalized UUIDs without changing the row", () => {
    const input = { context_source_refs: [
      { sourceId: sourceId.toUpperCase(), sourceVersion: 1 },
      { sourceId, sourceVersion: 2 },
      { sourceId: otherSourceId, sourceVersion: 3 },
    ] };
    const before = structuredClone(input);
    expect(sourceReferences(input)).toEqual([sourceId, sourceId, otherSourceId]);
    expect(input).toEqual(before);
  });

  it("accepts publication metadata on notes while requiring citations in other contexts", () => {
    const source = { sourceId, sourceVersion: 1, publication: true };
    const note = { context_source_refs: [source, { answerKeyBlockIds: [turnId] }, { publicationCardIds: [candidateId] }] };
    expect(noteProvenanceSourceReferences(note)).toEqual([sourceId]);
    expect(sourceReferences(note)).toBeNull();
    expect(noteProvenanceSourceReferences({ context_source_refs: [source, { answerKeyBlockIds: [null] }] })).toBeNull();
    expect(noteProvenanceSourceReferences({ context_source_refs: [{ sourceId, answerKeyBlockIds: [turnId] }] })).toBeNull();
  });

  it("accepts valid memory metadata on notes and rejects malformed entries", () => {
    const source = { sourceId, sourceVersion: 1 };
    const memory = { memoryDependencyIds: [turnId.toUpperCase()] };
    expect(noteProvenanceSourceReferences({ context_source_refs: [source, memory] })).toEqual([sourceId]);
    expect(noteProvenanceSourceReferences({ context_source_refs: [memory] })).toEqual([]);
    for (const ref of [{ memoryDependencyIds: [] }, { memoryDependencyIds: [null] }, { ...source, ...memory }]) {
      expect(noteProvenanceSourceReferences({ context_source_refs: [ref] })).toBeNull();
    }
  });

  it.each([{}, "[]", [null], [{}], [{ sourceId, sourceVersion: "1" }],
    [{ sourceId, sourceVersion: -1 }], [{ sourceId, sourceVersion: 1.5 }],
    [{ sourceId, sourceVersion: Number.MAX_SAFE_INTEGER + 1 }],
    [{ sourceId: "not-a-uuid", sourceVersion: 1 }],
  ].map(context_source_refs => ({ context_source_refs })))("rejects malformed context references $context_source_refs", (fields) => {
    expect(sourceReferences(fields)).toBeNull();
    expect(validateOpeningRestore(backup([turn(fields)]), [], currentMemoryDeletions).allowed).toBe(false);
  });

  it.each([{}, { context_source_refs: null }])("quarantines legacy assistant and dependent memory with unknown provenance %j", (fields) => {
    const input = backup([turn(fields)]);
    input.tables.opening_memories = [row({ id: candidateId, status: "active", source_turn_ids: [turnId] })];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(false);
  });

  it.each([undefined, null, "system"])("rejects missing or unknown turn role %s even with explicit empty provenance", (role) => {
    expect(validateOpeningRestore(backup([turn({ role, context_source_refs: [] })]), [], currentMemoryDeletions).allowed).toBe(false);
  });

  it("accepts explicit empty assistant provenance and its linked memory", () => {
    const input = backup([turn({ context_source_refs: [] })]);
    input.tables.opening_memories = [row({ id: candidateId, status: "active", source_turn_ids: [turnId] })];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
  });

  it.each([{}, { context_source_refs: null }])("preserves original user leaves with legacy provenance %j", (fields) => {
    const input = backup([turn({ role: "user", text: "Original user text", ...fields })]);
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
    expect(input).toEqual(before);
  });

  it("overlays the current deletion journal on mixed context-only sources and dependent rows", () => {
    const input = backup([turn({ context_source_refs: [
      { sourceId: sourceId.toUpperCase(), sourceVersion: 1 },
      { sourceId, sourceVersion: 2 },
      { sourceId: otherSourceId, sourceVersion: 3 },
    ] })]);
    input.tables.opening_memories = [row({ id: candidateId, status: "active", source_turn_ids: [turnId] })];
    input.tables.opening_assistant_candidates = [row({ id: candidateId, conversation_id: conversationId,
      source_turn_id: turnId, source_ids: [], payload: {} })];
    const before = structuredClone(input);
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
    expect(validateOpeningRestore(input, [mark], currentMemoryDeletions).errors).toContain("table opening_turns references a deleted source");
    expect(input).toEqual(before);
  });

  it.each([undefined, null, turnId])("rejects a candidate whose parent provenance is absent: %s", (source_turn_id) => {
    const input = backup([]);
    input.tables.opening_assistant_candidates = [row({ id: candidateId, conversation_id: conversationId,
      source_turn_id, source_ids: [], payload: {} })];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(false);
  });

  it("accepts assistant turn memoryDependencyIds in restore validation and apply planning when backed by exported memories", () => {
    const originTurnId = "77777777-7777-4777-8777-777777777777";
    const memoryId = "88888888-8888-4888-8888-888888888888";
    const documentlessTurn = turn({ context_source_refs: [{ memoryDependencyIds: [memoryId.toUpperCase()] }] });
    expect(turnMemoryDependencyIds(documentlessTurn)).toEqual([memoryId]);
    expect(turnSourceReferences(documentlessTurn)).toEqual([]);

    const mixedTurn = turn({
      context_source_refs: [
        { sourceId, sourceVersion: 0, memoryOnly: true },
        { memoryDependencyIds: [memoryId] },
      ],
    });
    expect(turnMemoryDependencyIds(mixedTurn)).toEqual([memoryId]);
    expect(turnSourceReferences(mixedTurn)).toEqual([sourceId]);
    // Only the turn and note readers admit memory dependency metadata.
    expect(sourceReferences(documentlessTurn)).toBeNull();
    expect(noteProvenanceSourceReferences(documentlessTurn)).toEqual([]);

    const originTurn = turn({ id: originTurnId, role: "user", context_source_refs: null });
    const memoryRow = row({ id: memoryId, kind: "confirmed", status: "active", source_turn_ids: [originTurnId] });
    for (const assistantTurn of [documentlessTurn, mixedTurn]) {
      const input = backup([originTurn, assistantTurn]);
      input.tables.opening_memories = [memoryRow];
      const before = structuredClone(input);
      expect(validateOpeningRestore(input, [], currentMemoryDeletions).allowed).toBe(true);
      expect(planOpeningRestoreApply(input, [], {
        confirmLocalRestore: true,
        currentMemoryDeletions,
      }).ok).toBe(true);
      expect(input).toEqual(before);
    }
  });

  it.each([
    { label: "missing", ancestor: null },
    { label: "revoked", ancestor: { kind: "confirmed", status: "revoked" } },
    { label: "superseded", ancestor: { kind: "confirmed", status: "superseded" } },
    { label: "rejected", ancestor: { kind: "confirmed", status: "rejected" } },
    { label: "candidate", ancestor: { kind: "candidate", status: "active" } },
    { label: "expired", ancestor: { kind: "temporary", status: "active", expires_at: "2000-01-01T00:00:00Z" } },
    { label: "unexpired", ancestor: { kind: "temporary", status: "active", expires_at: "2099-01-01T00:00:00Z" } },
  ])("checks $label ancestors through both edges of the backup graph", ({ label, ancestor }) => {
    const originalId = "aaaaaaaa-0000-4000-8000-000000000001";
    const ancestorId = "aaaaaaaa-0000-4000-8000-000000000002";
    const intermediateTurnId = "aaaaaaaa-0000-4000-8000-000000000003";
    const intermediateMemoryId = "aaaaaaaa-0000-4000-8000-000000000004";
    const input = backup([
      turn({ id: originalId, role: "user" }),
      turn({ id: intermediateTurnId, context_source_refs: [{ memoryDependencyIds: [ancestorId.toUpperCase()] }] }),
      turn({ context_source_refs: [{ memoryDependencyIds: [intermediateMemoryId.toUpperCase()] }] }),
    ]);
    input.tables.opening_memories = [
      row({ id: intermediateMemoryId, kind: "confirmed", status: "active", source_turn_ids: [intermediateTurnId.toUpperCase()] }),
      row({ id: candidateId, kind: "candidate", status: "active", source_turn_ids: [turnId] }),
      ...(ancestor ? [row({ id: ancestorId, source_turn_ids: [originalId.toUpperCase()], ...ancestor })] : []),
    ];
    const result = validateOpeningRestore(input, [], currentMemoryDeletions);
    expect(result.allowed).toBe(label === "unexpired");
    if (label !== "unexpired") expect(result.errors).toContain("memory source turn has an unavailable memory dependency");
  });

  it("propagates an unavailable dependency through a cycle", () => {
    const cycleId = "aaaaaaaa-0000-4000-8000-000000000005";
    const input = backup([
      turn({ context_source_refs: [{ memoryDependencyIds: [cycleId.toUpperCase(), candidateId] }] }),
    ]);
    input.tables.opening_memories = [
      row({ id: cycleId, kind: "confirmed", status: "active", source_turn_ids: [turnId] }),
    ];
    expect(validateOpeningRestore(input, [], currentMemoryDeletions).errors)
      .toContain("memory source turn has an unavailable memory dependency");
  });

  it.each([
    { name: "empty array", refs: [{ memoryDependencyIds: [] }] },
    { name: "non-UUID element", refs: [{ memoryDependencyIds: ["not-a-uuid"] }] },
    { name: "extra property", refs: [{ memoryDependencyIds: [candidateId], extra: true }] },
    { name: "mixed sourceId and memoryDependencyIds", refs: [{ sourceId, sourceVersion: 0, memoryDependencyIds: [candidateId] }] },
    { name: "duplicate memory IDs", refs: [{ memoryDependencyIds: [candidateId, candidateId.toUpperCase()] }] },
    { name: "multiple metadata elements", refs: [{ memoryDependencyIds: [candidateId] }, { memoryDependencyIds: [turnId] }] },
    { name: "user turn carrying memoryDependencyIds", role: "user", refs: [{ memoryDependencyIds: [candidateId] }] },
  ])("rejects malformed turn memoryDependencyIds ($name)", ({ role, refs }) => {
    const malformedTurn = turn({ role: role ?? "assistant", context_source_refs: refs });
    expect(turnMemoryDependencyIds(malformedTurn)).toBeNull();
    expect(turnSourceReferences(malformedTurn)).toBeNull();
    const input = backup([malformedTurn]);
    const preview = validateOpeningRestore(input, [], currentMemoryDeletions);
    expect(preview.allowed).toBe(false);
    expect(preview.errors).toContain("table opening_turns has invalid source lineage");
  });

  it("preserves note dependencies as lineage markers and rejects unavailable turn dependencies", () => {
    const originTurnId = "77777777-7777-4777-8777-777777777777";
    const memoryId = "88888888-8888-4888-8888-888888888888";

    // Opening archives retain the marker even when the personal note's memory is gone.
    const noteBackup = backup([]);
    noteBackup.tables.library_documents = [row({ id: candidateId })];
    noteBackup.tables.opening_note_provenance = [row({
      document_id: candidateId,
      context_source_refs: [{ memoryDependencyIds: [memoryId] }],
    })];
    expect(validateOpeningRestore(noteBackup, [], currentMemoryDeletions).allowed).toBe(true);

    // 2. Dangling memoryDependencyIds (missing from opening_memories) fails closed and requires live memory deletion facts.
    const danglingBackup = backup([turn({ context_source_refs: [{ memoryDependencyIds: [memoryId] }] })]);
    const missingFacts = validateOpeningRestore(danglingBackup, []);
    expect(missingFacts.allowed).toBe(false);
    expect(missingFacts.errors).toContain("current owner-scoped memory deletion facts are required");
    expect(missingFacts.errors).toContain("table opening_turns references a memory missing from the backup");

    // 3. Turn referencing a memory deleted in currentMemoryDeletions fails closed.
    const deletedBackup = backup([
      turn({ id: originTurnId, role: "user", context_source_refs: null }),
      turn({ context_source_refs: [{ memoryDependencyIds: [memoryId] }] }),
    ]);
    deletedBackup.tables.opening_memories = [row({ id: memoryId, status: "active", source_turn_ids: [originTurnId] })];
    const deletedFacts = {
      workspaceId,
      memories: [{ memoryId, deletedAt: "2026-11-21T00:00:00.000Z" }],
    };
    const deletedPreview = validateOpeningRestore(deletedBackup, [], deletedFacts);
    expect(deletedPreview.allowed).toBe(false);
    expect(deletedPreview.errors).toContain("table opening_turns references a deleted memory");
  });

  it.each([
    {
      name: "mixed source ref with scalar publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1, publicationCardIds: candidateId }],
    },
    {
      name: "mixed source ref with array publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1, publicationCardIds: [candidateId] }],
    },
    {
      name: "nested array publicationCardIds",
      refs: [[{ publicationCardIds: [candidateId] }]],
    },
    {
      name: "valid source ref alongside nested array publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1 }, [[{ publicationCardIds: [candidateId] }]]],
    },
    {
      name: "nested object metadata under valid source ref",
      refs: [{ sourceId, sourceVersion: 1, nested: { publicationCardIds: [candidateId] } }],
    },
    {
      name: "mixed source ref with answerKeyBlockIds alongside publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1, answerKeyBlockIds: [turnId] }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "mixed source ref with originTurnIds alongside publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1, originTurnIds: [turnId] }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "mixed source ref with snippetLineageVersion alongside publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1, snippetLineageVersion: 1 }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "mixed source ref with memoryDependencyIds alongside publicationCardIds",
      refs: [{ sourceId, sourceVersion: 1, memoryDependencyIds: [turnId] }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "33-level nested array publicationCardIds with tab/newline/NBSP/BOM whitespace",
      refs: [{
        publicationCardIds: Array.from({ length: 33 }).reduce<unknown>(
          acc => [acc],
          `\t\r\n\u00a0${candidateId.toUpperCase()}\ufeff\v\f`,
        ),
      }],
    },
    {
      name: "64-level nested array publicationCardIds inside nested publicationCardIds object",
      refs: [{
        publicationCardIds: [{
          other: {
            publicationCardIds: Array.from({ length: 64 }).reduce<unknown>(acc => [acc], `\t${candidateId.toUpperCase()}\n`),
          },
        }],
      }],
    },
    {
      name: "valid source ref with extra array-valued legacy property",
      refs: [
        { sourceId, sourceVersion: 1, legacy: [{ sourceId: otherSourceId, sourceVersion: 1 }] },
        { publicationCardIds: [candidateId] },
      ],
    },
    {
      name: "valid source ref with empty array property",
      refs: [{ sourceId, sourceVersion: 1, extra: [] }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "valid source ref with deeply nested array property",
      refs: [{ sourceId, sourceVersion: 1, deep: { nested: [1] } }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "note source ref with string publication value",
      refs: [{ sourceId, sourceVersion: 1, publication: "legacy" }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "note source ref with false publication value",
      refs: [{ sourceId, sourceVersion: 1, publication: false }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "note source ref with numeric publication value",
      refs: [{ sourceId, sourceVersion: 1, publication: 1 }, { publicationCardIds: [candidateId] }],
    },
    {
      name: "note source ref with null publication value",
      refs: [{ sourceId, sourceVersion: 1, publication: null }, { publicationCardIds: [candidateId] }],
    },
  ])("fails closed on $name so linked root-null and observation cards are excluded from backup", ({ refs }) => {
    const docId = "99999999-9999-4999-8999-999999999999";
    const obsCardId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const keepCardId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const obsId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const activityId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const rootNullCard = {
      id: candidateId,
      workspace_id: workspaceId,
      origin_observation_root_id: null,
      source_document_id: null,
      source_ids: [],
    };
    const observationCard = {
      id: obsCardId,
      workspace_id: workspaceId,
      origin_observation_root_id: obsId,
      source_document_id: null,
      source_ids: [],
    };
    const cleanCard = {
      id: keepCardId,
      workspace_id: workspaceId,
      origin_observation_root_id: null,
      source_document_id: null,
      source_ids: [],
    };
    const provenanceRow = {
      document_id: docId,
      workspace_id: workspaceId,
      context_source_refs: refs,
    };

    expect(parseNoteContextProvenanceRefs(refs)).toBeNull();
    expect(parseNoteContextSourceRefs(refs)).toBeNull();
    expect(noteProvenanceSourceReferences(provenanceRow)).toBeNull();
    expect(projectOpeningBackupCardSources({
      cards: [rootNullCard, observationCard, cleanCard],
      library_documents: [{ id: docId, deleted_at: null }],
      opening_sources: [{ id: sourceId }],
      opening_learning_observations: [{ id: obsId, activity_id: activityId }],
      opening_teaching_activities: [{ id: activityId, source_ids: [sourceId] }],
      opening_teaching_activity_specs: [{ activity_id: activityId, document_id: docId, source_refs: [] }],
    }, [provenanceRow])).toEqual([cleanCard]);
    expect(projectOpeningBackupProvenance([provenanceRow], new Set([candidateId, obsCardId]))).toEqual([provenanceRow]);

    const datasetResult = projectPrivacyGuardedOpeningDataset({
      scope: { workspaceId, ownerUserId: ownerId },
      privacyEpoch: 0,
      mode: "solo",
      role: "learner",
      tables: {
        cards: [{ ...rootNullCard, owner_user_id: ownerId }, { ...cleanCard, owner_user_id: ownerId }],
        library_documents: [],
        opening_sources: [{ id: sourceId, workspace_id: workspaceId, upload_state: "uploaded" }],
        opening_teaching_activities: [
          {
            id: activityId,
            workspace_id: workspaceId,
            owner_user_id: ownerId,
            generate_status: "ready",
            source_ids: [sourceId],
            create_intent: { kind: "card_review_variant", cardId: candidateId },
          },
          {
            id: obsId,
            workspace_id: workspaceId,
            owner_user_id: ownerId,
            generate_status: "ready",
            source_ids: [sourceId],
            create_intent: { kind: "card_review_variant", cardId: keepCardId },
          },
        ],
        opening_note_provenance: [{ ...provenanceRow, snippet_origin: false }],
      },
    }, (kind, id) => `${kind}:${id}`);
    expect(datasetResult.dataset.coursePackageQuality.map(item => item.identity)).toEqual([`activity:${obsId}`]);
  });

  it.each([4_096, 10_000])("handles %i-deep nested publicationCardIds arrays and deep object structures without RangeError", depth => {
    const allEcmaSpaces = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const docId = "99999999-9999-4999-8999-999999999999";
    const objCardId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const keepCardId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const activityA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const activityB = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const activityKeep = "11111111-1111-4111-8111-111111111111";

    let deepIds: unknown = [
      `${allEcmaSpaces}${candidateId.toUpperCase()}${allEcmaSpaces}`,
      { cardId: `${allEcmaSpaces}${objCardId.toUpperCase()}${allEcmaSpaces}` },
    ];
    for (let i = 0; i < depth; i++) {
      deepIds = [deepIds];
    }
    const refs = [{ publicationCardIds: deepIds }];
    const provenanceRow = {
      document_id: docId,
      workspace_id: workspaceId,
      context_source_refs: refs,
    };

    expect(parseBackupSourceRefs(refs)).toBeNull();
    expect(parseNoteContextProvenanceRefs(refs)).toBeNull();
    expect(parseNoteContextSourceRefs(refs)).toBeNull();
    expect(noteProvenanceSourceReferences(provenanceRow)).toBeNull();

    const cards = [
      { id: candidateId, workspace_id: workspaceId, origin_observation_root_id: null, source_document_id: null, source_ids: [] },
      { id: objCardId, workspace_id: workspaceId, origin_observation_root_id: null, source_document_id: null, source_ids: [] },
      { id: keepCardId, workspace_id: workspaceId, origin_observation_root_id: null, source_document_id: null, source_ids: [] },
    ];
    expect(projectOpeningBackupCardSources({
      cards,
      library_documents: [{ id: docId, deleted_at: null }],
      opening_sources: [{ id: sourceId }],
    }, [provenanceRow])).toEqual([cards[2]]);

    const datasetResult = projectPrivacyGuardedOpeningDataset({
      scope: { workspaceId, ownerUserId: ownerId },
      privacyEpoch: 0,
      mode: "solo",
      role: "learner",
      tables: {
        cards: cards.map(card => ({ ...card, owner_user_id: ownerId })),
        library_documents: [{ id: docId, workspace_id: workspaceId, deleted_at: null }],
        opening_sources: [{ id: sourceId, workspace_id: workspaceId, upload_state: "uploaded" }],
        opening_teaching_activities: [
          { id: activityA, workspace_id: workspaceId, owner_user_id: ownerId, generate_status: "ready", source_ids: [sourceId], create_intent: { kind: "card_review_variant", cardId: candidateId } },
          { id: activityB, workspace_id: workspaceId, owner_user_id: ownerId, generate_status: "ready", source_ids: [sourceId], create_intent: { kind: "card_review_variant", cardId: objCardId } },
          { id: activityKeep, workspace_id: workspaceId, owner_user_id: ownerId, generate_status: "ready", source_ids: [sourceId], create_intent: { kind: "card_review_variant", cardId: keepCardId } },
        ],
        opening_note_provenance: [{ ...provenanceRow, snippet_origin: false }],
      },
    }, (kind, id) => `${kind}:${id}`);
    expect(datasetResult.dataset.coursePackageQuality.map(item => item.identity)).toEqual([`activity:${activityKeep}`]);

    let deepCleanObj: Record<string, unknown> = { leaf: "ok" };
    let deepBadObj: Record<string, unknown> = { legacy: [] };
    for (let i = 0; i < depth; i++) {
      deepCleanObj = { next: deepCleanObj };
      deepBadObj = { next: deepBadObj };
    }
    expect(containsDisallowedNoteMetadataOrArray(deepCleanObj)).toBe(false);
    expect(dbContainsDisallowedNoteMetadataOrArray(deepCleanObj)).toBe(false);
    expect(containsDisallowedNoteMetadataOrArray(deepBadObj)).toBe(true);
    expect(dbContainsDisallowedNoteMetadataOrArray(deepBadObj)).toBe(true);
    expect(parseBackupSourceRefs([{ sourceId, sourceVersion: 1, extra: deepBadObj }])).toBeNull();
    expect(parseBackupSourceRefs([{ sourceId, sourceVersion: 1, extra: deepCleanObj }])).toEqual([{ sourceId, sourceVersion: 1 }]);
    expect(parseContextSourceRefs([{
      chunkId: turnId,
      sourceId: sourceId.toUpperCase(),
      sourceVersion: 2,
      label: "Section 1",
      page: 3,
      startMs: 100,
      endMs: 250,
      keyframeChunkId: "frame-1",
      slideLabel: "Slide 2",
    }])).toEqual([{ sourceId, sourceVersion: 2 }]);
  });
});
