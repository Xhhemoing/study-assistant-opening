import { describe, expect, it } from "vitest";
import type { NativeBackupSnapshot } from "@aistudy/domain/native";
import { filterNativeNotes, readNoteBackupProvenance } from "./native-note-privacy";
const sourceId = "10000000-0000-4000-8000-000000000001";
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
});
