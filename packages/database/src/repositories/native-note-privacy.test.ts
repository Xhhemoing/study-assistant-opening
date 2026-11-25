import { describe, expect, it } from "vitest";
import type { NativeBackupSnapshot } from "@aistudy/domain/native";
import type { Sql } from "postgres";
import { parseBackupSourceRefs } from "./backup-publication-provenance";
import {
  assertNativeCardRestorePrivacy,
  assertNativeNoteRestorePrivacy,
  filterNativeNotes,
  readNoteBackupProvenance,
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
  });
});
