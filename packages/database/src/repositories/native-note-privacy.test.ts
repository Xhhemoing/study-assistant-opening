import { describe, expect, it } from "vitest";
import type { NativeBackupSnapshot } from "@aistudy/domain/native";
import type { Sql } from "postgres";
import { parseBackupSourceRefs } from "./backup-publication-provenance";
import {
  assertNativeCardRestorePrivacy,
  assertNativeNoteRestorePrivacy,
  filterNativeNotes,
  readNoteBackupProvenance,
  retainNativeRestoreProvenance,
} from "./native-note-privacy";
const sourceId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000002";
const memoryId = "30000000-0000-4000-8000-000000000003";
const docId = "40000000-0000-4000-8000-000000000004";
function snapshot(): NativeBackupSnapshot {
  return {
    sourceWorkspaceId: "workspace", workspace: { id: "workspace" }, latestMigrationId: "0035_opening_note_provenance.sql",
    courses: [], goals: [], windows: [], explorations: [],
    documents: [{ id: "private-note", title: "PRIVATE-NOTE" }, { id: "ordinary-note", title: "ordinary" }],
    blocks: [{ id: "private-block", documentId: "private-note", content: { text: "PRIVATE-BODY", href: "private.txt", bytesBase64: "cHJpdmF0ZQ==" } }, { id: "ordinary-block", documentId: "ordinary-note", content: { text: "ordinary" } }],
    revisions: [{ id: "private-revision", documentId: "private-note", blocks: [{ content: { text: "PRIVATE-REVISION" } }] }],
    relations: [{ id: "private-relation", fromId: "ordinary-note", toId: "private-block" }],
    memberships: [{ id: "private-membership", assetType: "document", assetId: "private-note" }, { id: "source-membership", assetType: "source", assetId: sourceId }],
    cards: [{ id: "private-card", sourceDocumentId: "private-note", front: "PRIVATE-CARD" }],
    events: [{ id: "private-event", contentId: "private-card", payload: { answer: "PRIVATE-EVENT" } }],
    promotions: [{ id: "private-promotion", targetId: "private-note", body: "PRIVATE-PROMOTION" }],
    files: [{ path: "private.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) }],
  };
}
describe("native linked note privacy", () => {
  it("removes restricted current and historical text plus native dependent records and files", () => {
    const filtered = filterNativeNotes(snapshot(), new Map([["private-note", null]]));
    expect(filtered.documents).toEqual([{ id: "ordinary-note", title: "ordinary", openingProvenance: null }]);
    expect(filtered.blocks).toHaveLength(1);
    for (const collection of [filtered.revisions, filtered.relations, filtered.memberships, filtered.cards, filtered.events, filtered.promotions, filtered.files]) expect(collection).toEqual([]);
    expect(JSON.stringify(filtered)).not.toContain("PRIVATE-");
  });
  it("keeps known source versions outside editable blocks and marks ordinary notes separately", () => {
    const refs = [{ sourceId, sourceVersion: 4 }];
    const filtered = filterNativeNotes(snapshot(), new Map([["private-note", { contextSourceRefs: refs }]]));
    expect(filtered.documents[0]).toMatchObject({ openingProvenance: { contextSourceRefs: refs } });
    expect(filtered.documents[1]).toMatchObject({ openingProvenance: null });
    expect(filtered.memberships.map(row => row.id)).toEqual(["private-membership"]);
  });
  it("accepts legacy independent notes but refuses missing or unknown modern lineage", () => {
    expect(readNoteBackupProvenance({ id: "old-note" }, false)).toBeNull();
    expect(readNoteBackupProvenance({ id: "manual", openingProvenance: null }, true)).toBeNull();
    expect(() => readNoteBackupProvenance({ id: "lost-metadata" }, true)).toThrow(/missing/);
    expect(() => readNoteBackupProvenance({ id: "unknown", openingProvenance: { contextSourceRefs: null } }, true)).toThrow(/unknown/);
    expect(readNoteBackupProvenance({ id: "known-empty", openingProvenance: { contextSourceRefs: [] } }, true)).toEqual({ contextSourceRefs: [] });
  });

  it.each([[32, true], [33, false]] as const)("validates a retained card's deduplicated source union of %i", async (size, allowed) => {
    const source = (i: number) => `10000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    const retained = Array.from({ length: 31 }, (_, i) => source(i + 1));
    const db = ((parts: TemplateStringsArray) => parts.join("").includes("FROM cards")
      ? [{ source_ids: retained }] : [{ included: true }]) as unknown as Sql;
    const packed = {
      schemaManifest: { latestMigrationId: "0064_card_source_lineage.sql" },
      sourceWorkspaceId: "workspace",
      records: { cards: [{ id: "card", sourceIds: [source(10).toUpperCase(), ...Array.from({ length: size - 31 }, (_, i) => source(i + 32))] }] },
    } as Parameters<typeof assertNativeCardRestorePrivacy>[2];
    const restore = assertNativeCardRestorePrivacy(db, "workspace", packed, { cards: ["card"] } as Parameters<typeof assertNativeCardRestorePrivacy>[3]);
    if (allowed) await expect(restore).resolves.toBeUndefined();
    else await expect(restore).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("32") });
  });

  it("enforces note metadata structural validation and publication flag validation in parseBackupSourceRefs", () => {
    expect(parseBackupSourceRefs([
      { sourceId: sourceId.toUpperCase(), sourceVersion: 1, memoryOnly: true, publication: true },
      { memoryDependencyIds: [memoryId.toUpperCase()] },
      { originTurnIds: [turnId.toUpperCase()] },
      { snippetLineageVersion: 1 },
      { answerKeyBlockIds: [docId] },
      { publicationCardIds: [docId] },
    ])).toEqual([{ sourceId, sourceVersion: 1, memoryOnly: true, publication: true }]);

    for (const malformed of [
      [{ sourceId, sourceVersion: 1, legacy: [] }],
      [{ sourceId, sourceVersion: 1, nested: { extra: [1] } }],
      [{ sourceId, sourceVersion: 1, publication: false }],
      [{ sourceId, sourceVersion: 1, publication: "true" }],
      [{ sourceId, sourceVersion: 1, publication: null }],
      [{ sourceId, sourceVersion: 1, publication: 1 }],
      [{ sourceId, sourceVersion: 1, publicationCardIds: [docId] }],
      [[{ publicationCardIds: [docId] }]],
      [{ memoryDependencyIds: [] }],
      [{ originTurnIds: [] }],
      [{ snippetLineageVersion: 2 }],
    ]) {
      expect(parseBackupSourceRefs(malformed)).toBeNull();
    }
  });

  it("validates and normalizes snippet lineage fields in readNoteBackupProvenance", () => {
    expect(readNoteBackupProvenance({
      id: docId,
      openingProvenance: {
        contextSourceRefs: [],
        answerKeyBlockIds: [docId.toUpperCase(), docId],
        memoryDependencyIds: [memoryId.toUpperCase(), sourceId.toUpperCase(), memoryId],
        originTurnIds: [turnId.toUpperCase(), turnId],
        snippetLineageVersion: 1,
      },
    }, true)).toEqual({
      contextSourceRefs: [],
      answerKeyBlockIds: [docId],
      memoryDependencyIds: [sourceId, memoryId],
      originTurnIds: [turnId],
      snippetLineageVersion: 1,
    });

    for (const bad of [
      { contextSourceRefs: [], extra: true },
      { contextSourceRefs: [{ sourceId, sourceVersion: 1, legacy: [] }] },
      { contextSourceRefs: [{ sourceId, sourceVersion: 1, publication: false }] },
      { contextSourceRefs: [{ memoryDependencyIds: [memoryId] }] },
      { contextSourceRefs: [{ snippetLineageVersion: 1 }] },
      { contextSourceRefs: [], memoryDependencyIds: [] },
      { contextSourceRefs: [], memoryDependencyIds: ["not-a-uuid"] },
      { contextSourceRefs: [], originTurnIds: [] },
      { contextSourceRefs: [], originTurnIds: ["not-a-uuid"] },
      { contextSourceRefs: [], snippetLineageVersion: 0 },
      { contextSourceRefs: [], snippetLineageVersion: 2 },
      { contextSourceRefs: [], snippetLineageVersion: "1" },
    ]) {
      expect(() => readNoteBackupProvenance({ id: docId, openingProvenance: bad }, true)).toThrow();
    }
  });

  it("enforces same-workspace and anti-stripping checks for snippet lineage in assertNativeNoteRestorePrivacy", async () => {
    const dbAdmitted = ((parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("FROM opening_note_provenance")) return [];
      return [{ included: true }];
    }) as unknown as Sql;

    for (const crossWorkspaceProvenance of [
      { contextSourceRefs: [], memoryDependencyIds: [memoryId], snippetLineageVersion: 1 },
      { contextSourceRefs: [], originTurnIds: [turnId], snippetLineageVersion: 1 },
    ]) {
      const packed = {
        schemaManifest: { latestMigrationId: "0064_card_source_lineage.sql" },
        sourceWorkspaceId: "source-workspace",
        records: { documents: [{ id: docId, openingProvenance: crossWorkspaceProvenance }] },
      } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
      await expect(assertNativeNoteRestorePrivacy(dbAdmitted, "target-workspace", packed))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }

    const dbWithExisting = ((parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("FROM opening_note_provenance")) {
        return [{ document_id: docId, context_source_refs: [{ snippetLineageVersion: 1 }, { originTurnIds: [turnId] }] }];
      }
      return [{ included: true }];
    }) as unknown as Sql;
    const stripped = {
      schemaManifest: { latestMigrationId: "0064_card_source_lineage.sql" },
      sourceWorkspaceId: "workspace",
      records: { documents: [{ id: docId.toUpperCase(), openingProvenance: null }] },
    } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
    await expect(assertNativeNoteRestorePrivacy(dbWithExisting, "workspace", stripped))
      .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("remove existing note provenance") });

    const dbMalformedCurrent = ((parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("FROM opening_note_provenance")) {
        return [{ document_id: docId, context_source_refs: [{ sourceId, sourceVersion: 1, legacy: [] }] }];
      }
      return [{ included: true }];
    }) as unknown as Sql;
    const retainPacked = {
      schemaManifest: { latestMigrationId: "0064_card_source_lineage.sql" },
      sourceWorkspaceId: "workspace",
      records: { documents: [{ id: docId, openingProvenance: { contextSourceRefs: [{ sourceId, sourceVersion: 1 }] } }] },
    } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
    await expect(assertNativeNoteRestorePrivacy(dbMalformedCurrent, "workspace", retainPacked))
      .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("unknown") });

    const retainedBlockId = "50000000-0000-4000-8000-000000000005";
    const retainedCardId = "60000000-0000-4000-8000-000000000006";
    const otherEntityId = "70000000-0000-4000-8000-000000000007";
    const childId = "80000000-0000-4000-8000-000000000008";

    for (const retainedRefs of [
      [{ sourceId, sourceVersion: 1 }, { snippetLineageVersion: 1 }],
      [{ memoryDependencyIds: [memoryId] }, { snippetLineageVersion: 1 }],
      [{ snippetLineageVersion: 1 }, { originTurnIds: [turnId] }],
    ]) {
      const dbRetainedChildOnly = ((parts: TemplateStringsArray) => {
        const query = parts.join("");
        if (query.includes("FROM library_blocks")) return [{ document_id: docId }];
        if (query.includes("FROM cards")) return [{ document_id: docId }];
        if (query.includes("FROM opening_note_provenance")) {
          return [{ document_id: docId, workspace_id: "target-workspace", context_source_refs: retainedRefs }];
        }
        return [{ included: true }];
      }) as unknown as Sql;

      for (const childRecords of [
        { documents: [], blocks: [{ id: childId, documentId: docId }] },
        { documents: [], revisions: [{ id: childId, documentId: docId }] },
        { documents: [], cards: [{ id: childId, sourceDocumentId: docId }] },
        { documents: [], cards: [{ id: retainedCardId, sourceDocumentId: null }] },
        { documents: [], memberships: [{ id: childId, assetType: "document", assetId: docId }] },
        { documents: [], memberships: [{ id: childId, assetType: "block", assetId: retainedBlockId }] },
        { documents: [], relations: [{ id: childId, fromType: "document", fromId: docId, toType: "document", toId: otherEntityId }] },
        { documents: [], relations: [{ id: childId, fromType: "document", fromId: otherEntityId, toType: "block", toId: retainedBlockId }] },
        { documents: [], promotions: [{ id: childId, targetType: "document", targetId: docId }] },
        { documents: [], promotions: [{ id: childId, targetId: retainedBlockId }] },
        { documents: [], promotions: [{ id: childId, targets: [{ id: otherEntityId, targetId: docId }] }] },
        { documents: [], promotions: [{ id: childId, targets: [{ id: otherEntityId, targetId: retainedBlockId }] }] },
      ]) {
        const childOnlyPacked = {
          schemaManifest: { latestMigrationId: "0064_card_source_lineage.sql" },
          sourceWorkspaceId: "source-workspace",
          records: childRecords,
        } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
        await expect(assertNativeNoteRestorePrivacy(dbRetainedChildOnly, "target-workspace", childOnlyPacked))
          .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("original workspace") });
      }
    }
  });

  it("rejects foreign and restricted restores targeting retained automatic cards resolved via teaching documents", async () => {
    const autoCardId = "61000000-0000-4000-8000-000000000061";
    const teachingDocId = "62000000-0000-4000-8000-000000000062";
    const reviewId = "63000000-0000-4000-8000-000000000063";
    const targetWorkspaceId = "64000000-0000-4000-8000-000000000064";
    const foreignWorkspaceId = "65000000-0000-4000-8000-000000000065";

    const dbForeignAutoCard = ((parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("FROM learning_events")) return [];
      if (query.includes("FROM cards")) {
        return [{
          card_id: autoCardId,
          source_document_id: null,
          teaching_doc_id: teachingDocId,
          document_id: teachingDocId,
          has_opening_lineage: true,
          origin_valid: true,
          card_readable: true,
          origin_admitted: true,
          source_doc_teaching_admitted: true,
          teaching_doc_active: true,
          teaching_doc_spec_allowed: true,
        }];
      }
      if (query.includes("FROM opening_note_provenance")) return [];
      return [{ included: true }];
    }) as unknown as Sql;

    const foreignChildPacked = {
      schemaManifest: { latestMigrationId: "0085_cards_fsrs.sql" },
      sourceWorkspaceId: foreignWorkspaceId,
      records: { events: [{ id: reviewId, type: "review", contentId: autoCardId }] },
    } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
    await expect(assertNativeNoteRestorePrivacy(dbForeignAutoCard, targetWorkspaceId, foreignChildPacked))
      .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("original workspace") });

    for (const invalidRow of [
      { origin_valid: false },
      { card_readable: false },
      { origin_admitted: false },
      { teaching_doc_active: false },
      { teaching_doc_spec_allowed: false },
    ]) {
      const dbUnavailableAutoCard = ((parts: TemplateStringsArray) => {
        const query = parts.join("");
        if (query.includes("FROM learning_events")) return [];
        if (query.includes("FROM cards")) {
          return [{
            card_id: autoCardId,
            source_document_id: null,
            teaching_doc_id: null,
            document_id: null,
            has_opening_lineage: true,
            origin_valid: true,
            card_readable: true,
            origin_admitted: true,
            source_doc_teaching_admitted: true,
            teaching_doc_active: true,
            teaching_doc_spec_allowed: true,
            ...invalidRow,
          }];
        }
        if (query.includes("FROM opening_note_provenance")) return [];
        return [{ included: true }];
      }) as unknown as Sql;

      const sameWorkspacePacked = {
        schemaManifest: { latestMigrationId: "0085_cards_fsrs.sql" },
        sourceWorkspaceId: targetWorkspaceId,
        records: { events: [{ id: reviewId, type: "review", contentId: autoCardId }] },
      } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
      await expect(assertNativeNoteRestorePrivacy(dbUnavailableAutoCard, targetWorkspaceId, sameWorkspacePacked))
        .rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("rejects foreign-workspace and deleted-document publicationCardIds provenance links", async () => {
    const candidateCardId = "71000000-0000-4000-8000-000000000071";
    const pubDocId = "72000000-0000-4000-8000-000000000072";
    const targetWorkspaceId = "73000000-0000-4000-8000-000000000073";
    const foreignWorkspaceId = "74000000-0000-4000-8000-000000000074";
    const capturedQueries: string[] = [];

    const dbForeignPub = ((parts: TemplateStringsArray) => {
      const query = parts.join("");
      capturedQueries.push(query);
      if (query.includes("FROM cards")) return [];
      if (query.includes("FROM opening_note_provenance")) {
        return [{
          document_id: pubDocId,
          workspace_id: foreignWorkspaceId,
          context_source_refs: [{ publicationCardIds: [candidateCardId] }],
          matched_by_publication_card: true,
          doc_exists_anywhere: true,
          doc_active: false,
        }];
      }
      return [{ included: true }];
    }) as unknown as Sql;

    const cardPacked = {
      schemaManifest: { latestMigrationId: "0085_cards_fsrs.sql" },
      sourceWorkspaceId: targetWorkspaceId,
      records: { cards: [{ id: candidateCardId, sourceIds: [] }] },
    } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
    await expect(assertNativeNoteRestorePrivacy(dbForeignPub, targetWorkspaceId, cardPacked))
      .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("unknown") });
    expect(capturedQueries.some(q => q.includes("FROM opening_note_provenance") && !q.includes("WHERE (p.workspace_id="))).toBe(true);

    const dbSoftDeletedPub = Object.assign(
      ((parts: TemplateStringsArray) => {
        const query = parts.join("");
        if (query.includes("FROM cards")) return [];
        if (query.includes("FROM opening_note_provenance")) {
          return [{
            document_id: pubDocId,
            workspace_id: targetWorkspaceId,
            context_source_refs: [{ publicationCardIds: [candidateCardId] }],
            matched_by_publication_card: true,
            doc_exists_anywhere: true,
            doc_active: false,
          }];
        }
        return [{ included: true }];
      }) as unknown as Sql,
      { json: (val: unknown) => val },
    ) as unknown as Sql;
    await expect(assertNativeNoteRestorePrivacy(dbSoftDeletedPub, targetWorkspaceId, cardPacked))
      .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("deleted, excluded, or unavailable") });
  });

  it("walks stored learning_events chains for incoming corrections and colliding skipped reviews", async () => {
    const cleanCardId = "81000000-0000-4000-8000-000000000081";
    const hiddenCardId = "82000000-0000-4000-8000-000000000082";
    const collidingReviewId = "83000000-0000-4000-8000-000000000083";
    const correctionId = "84000000-0000-4000-8000-000000000084";
    const workspaceId = "85000000-0000-4000-8000-000000000085";

    const dbEventChain = ((parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("WITH RECURSIVE event_chain")) {
        return [{ content_id: hiddenCardId }];
      }
      if (query.includes("FROM cards")) {
        return [{
          card_id: hiddenCardId,
          source_document_id: null,
          teaching_doc_id: null,
          document_id: null,
          has_opening_lineage: true,
          origin_valid: true,
          card_readable: false,
          origin_admitted: true,
          source_doc_teaching_admitted: true,
          teaching_doc_active: true,
          teaching_doc_spec_allowed: true,
        }];
      }
      if (query.includes("FROM opening_note_provenance")) return [];
      return [{ included: true }];
    }) as unknown as Sql;

    const skipCollisionPacked = {
      schemaManifest: { latestMigrationId: "0085_cards_fsrs.sql" },
      sourceWorkspaceId: workspaceId,
      records: {
        events: [
          { id: collidingReviewId, type: "review", contentId: cleanCardId },
          { id: correctionId, type: "correction", correctsEventId: collidingReviewId },
        ],
      },
    } as Parameters<typeof assertNativeNoteRestorePrivacy>[2];
    await expect(assertNativeNoteRestorePrivacy(dbEventChain, workspaceId, skipCollisionPacked))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("normalizes uppercase UUID spellings across same-workspace note, card, and provenance retention checks", async () => {
    const workspaceId = "91000000-0000-4000-8000-000000000091";
    const ownerUserId = "92000000-0000-4000-8000-000000000092";
    const cardId = "93000000-0000-4000-8000-000000000093";
    const obsId = "94000000-0000-4000-8000-000000000094";
    const teachingDocId = "95000000-0000-4000-8000-000000000095";

    const dbSameWorkspaceUpper = Object.assign(
      ((parts: TemplateStringsArray) => {
        const query = parts.join("");
        if (query.includes("FROM opening_learning_observations")) return [{ id: obsId }];
        if (query.includes("SELECT source_ids,origin_observation_root_id,source_document_id")) {
          return [{ source_ids: [sourceId], origin_observation_root_id: obsId, source_document_id: docId }];
        }
        if (query.includes("FROM cards")) return [];
        if (query.includes("FROM opening_note_provenance")) {
          return [{
            document_id: docId,
            workspace_id: workspaceId,
            context_source_refs: [{ sourceId, sourceVersion: 1 }],
            matched_by_publication_card: false,
            doc_exists_anywhere: true,
            doc_active: true,
          }];
        }
        if (query.includes("FROM library_documents")) return [{ id: docId }];
        return [{ included: true }];
      }) as unknown as Sql,
      { json: (val: unknown) => val },
    ) as unknown as Sql;

    const upperPacked = {
      schemaManifest: { latestMigrationId: "0085_cards_fsrs.sql" },
      sourceWorkspaceId: workspaceId.toUpperCase(),
      records: {
        documents: [{
          id: docId.toUpperCase(),
          openingProvenance: { contextSourceRefs: [{ sourceId: sourceId.toUpperCase(), sourceVersion: 1 }] },
        }],
        cards: [{
          id: cardId.toUpperCase(),
          ownerUserId: ownerUserId.toUpperCase(),
          sourceIds: [sourceId.toUpperCase()],
          originObservationRootId: obsId.toUpperCase(),
          sourceDocumentId: docId.toUpperCase(),
          originTeachingDocumentIds: [teachingDocId.toUpperCase()],
        }],
      },
    } as unknown as Parameters<typeof assertNativeCardRestorePrivacy>[2];

    await expect(assertNativeNoteRestorePrivacy(dbSameWorkspaceUpper, workspaceId, upperPacked)).resolves.toBeUndefined();
    await expect(assertNativeCardRestorePrivacy(
      dbSameWorkspaceUpper,
      workspaceId,
      upperPacked,
      { cards: [cardId] } as Parameters<typeof assertNativeCardRestorePrivacy>[3],
    )).resolves.toBeUndefined();
    await expect(retainNativeRestoreProvenance(
      dbSameWorkspaceUpper,
      workspaceId,
      upperPacked,
      { cards: [cardId] } as Parameters<typeof retainNativeRestoreProvenance>[3],
    )).resolves.toBeUndefined();
  });
});
