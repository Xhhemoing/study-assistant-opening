import { expect, test } from "@playwright/test";

function userInput(label: string) {
  return { email: `${label}-${Date.now()}@example.com`, password: "password123", displayName: label };
}

test("requires an explicit decision for a concurrent note revision proposal", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const registered = await context.request.post("/api/auth/register", { data: userInput("revision-proposal") });
    expect(registered.status()).toBe(201);
    const blockId = "11111111-1111-4111-8111-111111111111";
    const created = await context.request.post("/api/documents", { data: { title: "Confirmed note", lifecycle: "confirmed", blocks: [{ id: blockId, type: "paragraph", content: { text: "base" } }] } });
    expect(created.status()).toBe(201);
    const document = (await created.json()).document;
    const proposal = await context.request.post(`/api/documents/${document.id}/revision-proposals`, { data: { proposedBlocks: [{ id: blockId, type: "paragraph", position: 0, content: { text: "proposal" } }], proposedTitle: "Proposed note", source: { kind: "ai", provider: "luna", model: null, sourceId: null, metadata: {} }, provenance: { origin: "ai", actorUserId: null, sourceDocumentId: null, sourceRevisionNumber: null }, supportState: "supported" } });
    expect(proposal.status()).toBe(201);
    const listed = await context.request.get(`/api/documents/${document.id}/revision-proposals`);
    expect(listed.status()).toBe(200);
    expect((await listed.json()).proposals[0].status).toBe("pending");
    const proposalRecord = (await proposal.json()).proposal;

    const concurrentEdit = await context.request.patch(`/api/documents/${document.id}`, {
      data: {
        title: "Concurrent note",
        expectedRevisionNumber: document.currentRevisionNumber,
        blocks: [{ id: blockId, type: "paragraph", content: { text: "manual edit" } }],
      },
    });
    expect(concurrentEdit.status()).toBe(200);
    const current = (await concurrentEdit.json()).document;
    expect(current.currentRevisionNumber).toBe(document.currentRevisionNumber + 1);

    const accepted = await context.request.post(`/api/revision-proposals/${proposalRecord.id}/review`, {
      data: { action: "accept" },
    });
    expect(accepted.status()).toBe(200);
    const conflictBody = await accepted.json();
    expect(conflictBody.proposal.status).toBe("conflicted");
    expect(conflictBody.document.blocks[0].content.text).toBe("manual edit");

    const preserved = await context.request.post(`/api/revision-proposals/${proposalRecord.id}/resolve`, {
      data: {
        action: "preserve_both",
        selectedProposalBlockIds: [blockId],
        expectedCurrentRevisionNumber: current.currentRevisionNumber,
      },
    });
    expect(preserved.status()).toBe(200);
    const preservedBody = await preserved.json();
    expect(preservedBody.proposal.status).toBe("accepted");
    expect(preservedBody.document.blocks.map((block: { content: { text: string } }) => block.content.text).sort()).toEqual(["manual edit", "proposal"]);

    const finalDocument = await context.request.get(`/api/documents/${document.id}`);
    expect(finalDocument.status()).toBe(200);
    expect((await finalDocument.json()).document.blocks.map((block: { content: { text: string } }) => block.content.text).sort()).toEqual(["manual edit", "proposal"]);
    const revisions = await context.request.get(`/api/documents/${document.id}/revisions`);
    expect(revisions.status()).toBe(200);
    expect((await revisions.json()).revisions.map((revision: { revisionNumber: number }) => revision.revisionNumber)).toEqual([1, 2, 3]);
  } finally {
    await context.close();
  }
});
