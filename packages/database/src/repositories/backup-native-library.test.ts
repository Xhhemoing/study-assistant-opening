import { expect, it } from "vitest";
import { projectNativeBackupLibrary } from "./backup-native-library";

it.each([true, false])("projects a teaching document whose spec source is admitted: %s", admitted => {
  const document = { id: "lesson", title: "Teaching material" };
  const block = { id: "block", documentId: document.id, type: "text", content: { text: "Ordinary explanation" } };
  const revision = { id: "revision", documentId: document.id, blocks: [block] };
  const unrelated = { id: "essay" };
  const relation = { fromId: unrelated.id, toId: block.id };
  const membership = { assetId: document.id };
  const records = { documents: [document, unrelated], blocks: [block], revisions: [revision], relations: [relation],
    memberships: [membership], cards: [], promotions: [], events: [] };
  const specs = [{ document_id: document.id, source_refs: [{ sourceId: "source", sourceVersion: 1 }] }];
  const sources = new Set(admitted ? ["source"] : []);
  const projected = projectNativeBackupLibrary(records, [], [], sources, specs);
  expect(projected.records).toMatchObject({
    documents: admitted ? [document, unrelated] : [unrelated],
    blocks: admitted ? [block] : [],
    revisions: admitted ? [revision] : [],
    relations: admitted ? [relation] : [],
    memberships: admitted ? [membership] : [],
  });
});
