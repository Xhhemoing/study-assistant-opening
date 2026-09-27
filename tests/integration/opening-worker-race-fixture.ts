import { randomUUID } from "node:crypto";
import {
  createOpeningConversationRepository,
  createOpeningMemoryRepository,
  createOpeningSourceChunksRepository,
} from "@aistudy/database";
import type { OpeningFixture } from "./opening-fixture";

export const SECRET_ANSWER = "secret-model-answer-rp2";
export const RATES = { inputCentsPerMillion: 1_000_000, outputCentsPerMillion: 1_000_000 };

export type RaceSeed = {
  jobId: string;
  assistantTurnId: string;
  memoryId: string;
  memoryVersion: number;
  sessionId: string;
  chunkId: string;
  sourceId: string;
};

/** Real conversation, source, chunk, session, queued job, and sourced memory. */
export async function seedWorkerRace(fixture: OpeningFixture): Promise<RaceSeed> {
  const scope = fixture.scope;
  const sourceId = randomUUID();
  const sessionId = randomUUID();
  await fixture.sql`
    INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${scope.workspaceId}, 'race.pdf', 'application/pdf', 64,
      ${"a".repeat(64)}, 0, 'uploaded', 'ready')`;
  await createOpeningSourceChunksRepository(fixture.sql).replaceChunks(scope, {
    sourceId, sourceVersion: 0,
    chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: "cited race chunk", imageObjectKey: null }],
  });
  const chunk = await fixture.sql<{ id: string }[]>`
    SELECT id FROM opening_source_chunks WHERE source_id = ${sourceId} LIMIT 1`;
  const chunkId = chunk[0]?.id;
  if (!chunkId) throw new Error("race chunk missing");
  await fixture.sql`
    INSERT INTO opening_learning_sessions
      (id, workspace_id, owner_user_id, course_id, skill_label, source_ids)
    VALUES (${sessionId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${randomUUID()}, 'race', ${[sourceId]}::uuid[])`;
  const conversations = createOpeningConversationRepository(fixture.sql);
  const conversation = await conversations.create(scope, { title: "rp2", courseId: null });
  const saved = await conversations.appendSavedTurn({
    scope, conversationId: conversation.id, text: "race question", mode: "explain",
    clientKey: randomUUID(), sourceIds: [sourceId], learningSessionId: sessionId,
    currentPage: 1, chunkId,
  });
  const proposed = await createOpeningMemoryRepository(fixture.sql).proposeMemory(scope, {
    text: "race memory", sourceTurnIds: [saved.turnId], expiresAt: null,
  });
  return {
    jobId: saved.jobId, assistantTurnId: saved.assistantTurnId,
    memoryId: proposed.id, memoryVersion: proposed.version, sessionId, chunkId, sourceId,
  };
}

export function providerBody(chunkId: string): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      text: SECRET_ANSWER, citedChunkIds: [chunkId],
      candidates: [{ kind: "memory", text: "race candidate", temporary: false }],
    }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  });
}
