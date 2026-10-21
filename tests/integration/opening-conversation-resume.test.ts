import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningConversationRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const citation = {
  chunkId: "33333333-3333-4333-8333-333333333333",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceVersion: 1,
  label: "p.2",
};

let fixture: OpeningFixture;

beforeAll(async () => {
  fixture = await createOpeningFixture();
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await fixture?.close();
});

it("loads owned continuity turns with citations and hides other owners", async () => {
  const repo = createOpeningConversationRepository(fixture.sql);
  const owned = await repo.create(fixture.scope, { title: "resume", courseId: null });
  const foreign = await repo.create(fixture.otherScope, { title: "other", courseId: null });
  const saved = await repo.appendSavedTurn({
    scope: fixture.scope,
    conversationId: owned.id,
    text: "q",
    mode: "explain",
    purpose: "answer",
    clientKey: "resume-routing-replay",
    sourceIds: [],
    learningSessionId: null,
    currentPage: null,
    chunkId: null,
  });
  expect(await repo.findTurnByClientKey(fixture.scope, "resume-routing-replay", owned.id)).toMatchObject({
    userTurnId: saved.turnId, mode: "explain", purpose: "answer", querySystem: false,
  });
  await fixture.sql`
    UPDATE opening_turns
    SET status = 'complete', text = 'a', citations = ${fixture.sql.json([citation])}
    WHERE id = ${saved.assistantTurnId}
  `;
  await fixture.sql`
    INSERT INTO opening_turns (
      id, workspace_id, conversation_id, role, text, mode, status, citations
    ) VALUES (
      ${randomUUID()}, ${fixture.otherScope.workspaceId}, ${foreign.id},
      'assistant', 'secret', 'explain', 'complete', ${fixture.sql.json([citation])}
    )
  `;

  const turns = await repo.loadContinuityTurns(fixture.scope, owned.id);
  expect(turns).toEqual([
    { id: saved.turnId, role: "user", text: "q", citations: [] },
    { id: saved.assistantTurnId, role: "assistant", text: "a", citations: [citation] },
  ]);
  await expect(repo.loadContinuityTurns(fixture.otherScope, owned.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(repo.loadContinuityTurns(fixture.scope, foreign.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const anchor = { purpose: "learning_help", activityId: randomUUID(), blockId: randomUUID(), contentVersion: 2 };
  await fixture.sql`UPDATE opening_turns SET context_anchor=${fixture.sql.json(anchor)} WHERE id=${saved.turnId}`;
  expect(await repo.loadContinuityTurns(fixture.scope, owned.id, anchor)).toEqual([turns[0]]);
  expect(await repo.loadContinuityTurns(fixture.scope, owned.id, { ...anchor, contentVersion: 3 })).toEqual([]);
  expect(await repo.loadContinuityTurns(fixture.scope, owned.id, { ...anchor, blockId: randomUUID() })).toEqual([]);
});
