import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { reviseOpeningLearningObservation } from "@aistudy/database";
import { readOpeningBackupRecords } from "../../packages/database/src/repositories/opening-backup-records";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { backupRows } from "./opening-backup-records-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`TRUNCATE opening_learning_sessions, opening_conversations CASCADE`;
});
afterAll(async () => { await fixture?.close(); });

async function seedAttemptChain() {
  const f = await learningAttemptFixture(fixture), rows = backupRows(fixture.sql, fixture.scope);
  const attempt = await f.start(), exposure = await f.help(attempt), original = await f.submit(attempt);
  const [turn] = await fixture.sql`SELECT conversation_id FROM opening_turns WHERE id=${exposure.turnId}`;
  if (!turn) throw new Error("Missing help turn fixture");
  const candidateId = await rows.candidate(String(turn.conversation_id), exposure.turnId, [f.sourceId]);
  const memoryId = await rows.memory([exposure.turnId]);
  const cleanAttempt = await f.start(), cleanObservation = await f.submit(cleanAttempt);
  return { f, rows, attempt, exposure, original, candidateId, memoryId, cleanAttempt, cleanObservation };
}

function replace(rootId: string, headId = rootId, replacement = {}) {
  return reviseOpeningLearningObservation(fixture.sql, fixture.scope, {
    rootObservationId: rootId, revisesObservationId: headId, expectedHead: headId,
    revisionKind: "replace", reason: "Correct saved answer", clientKey: randomUUID(),
    replacement: { answer: "2", outcome: "incorrect", assistance: "independent", ...replacement },
  });
}

async function expectOnlyCleanAttempt(chain: Awaited<ReturnType<typeof seedAttemptChain>>) {
  const { tables } = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(tables.opening_learning_observations.map(row => row.id)).toEqual([chain.cleanObservation.id]);
  expect(tables.opening_learning_attempts.map(row => row.id)).toEqual([chain.cleanAttempt.id]);
  expect(tables.opening_turns).toEqual([]);
  expect(tables.opening_help_exposures).toEqual([]);
  expect(tables.opening_assistant_candidates).toEqual([]);
  expect(tables.opening_memories).toEqual([]);
  expect(tables.opening_sources.map(row => row.id)).toContain(chain.f.sourceId);
  // Export filtering must not erase the actual audit trail.
  expect(await fixture.sql`SELECT id FROM opening_learning_observations WHERE root_observation_id=${chain.original.id}`)
    .not.toHaveLength(0);
}

it.each(["reference_source_id", "reference_check"] as const)(
  "excludes the complete chain when an old revision's %s is private after its head cleared the reference", async field => {
    const chain = await seedAttemptChain(), referenceId = await chain.rows.source();
    await chain.rows.chunk(referenceId);
    await fixture.sql`UPDATE opening_learning_sessions SET source_ids=${[chain.f.sourceId, referenceId]} WHERE id=${chain.f.sessionId}`;
    const checked = await replace(chain.original.id, chain.original.id, {
      verdictSource: "reference_checked", referenceSourceId: referenceId,
      referenceCheck: { referenceSourceId: referenceId, method: "Compare every step", scope: "whole_answer" },
    });
    const head = await replace(chain.original.id, checked.headObservationId, { answer: "3" });
    expect(head.observation).toMatchObject({ referenceSourceId: null, referenceCheck: null });
    // Isolate historical provenance from the current session and the other reference representation.
    await fixture.sql`UPDATE opening_learning_sessions SET source_ids=${[chain.f.sourceId]} WHERE id=${chain.f.sessionId}`;
    if (field === "reference_source_id") {
      await fixture.sql`UPDATE opening_learning_observations SET reference_check=NULL WHERE id=${checked.headObservationId}`;
    } else {
      await fixture.sql`UPDATE opening_learning_observations SET reference_source_id=NULL WHERE id=${checked.headObservationId}`;
    }
    const before = await readOpeningBackupRecords(fixture.sql, fixture.scope);
    expect(before.tables.opening_learning_observations).toHaveLength(4);
    expect(before.tables.opening_learning_attempts).toHaveLength(2);
    expect(before.tables.opening_help_exposures).toMatchObject([{ id: chain.exposure.id }]);
    expect(before.tables.opening_assistant_candidates).toMatchObject([{ id: chain.candidateId }]);
    expect(before.tables.opening_memories).toMatchObject([{ id: chain.memoryId }]);
    await chain.rows.exclude(referenceId);
    await expectOnlyCleanAttempt(chain);
  },
);

it.each(["source", "turn"] as const)("does not revive an older root after deleting the head's linked %s", async kind => {
  const chain = await seedAttemptChain(), head = await replace(chain.original.id);
  if (kind === "source") {
    const sourceId = await chain.rows.source();
    await fixture.sql`UPDATE opening_learning_observations SET reference_source_id=${sourceId} WHERE id=${head.headObservationId}`;
    const before = await readOpeningBackupRecords(fixture.sql, fixture.scope);
    expect(before.tables.opening_learning_observations).toHaveLength(3);
    await fixture.sql`DELETE FROM opening_sources WHERE id=${sourceId}`;
  } else {
    const conversation = await chain.rows.conversation(), turnId = await chain.rows.turn(conversation, [chain.f.sourceId]);
    await fixture.sql`UPDATE opening_learning_observations SET source_turn_ids=${[turnId]} WHERE id=${head.headObservationId}`;
    const before = await readOpeningBackupRecords(fixture.sql, fixture.scope);
    expect(before.tables.opening_learning_observations).toHaveLength(3);
    await fixture.sql`DELETE FROM opening_turns WHERE id=${turnId}`;
  }
  await expectOnlyCleanAttempt(chain);
});

it("exports legacy observations with NULL revision metadata without inventing a head", async () => {
  const rows = backupRows(fixture.sql, fixture.scope), sourceId = await rows.source();
  const sessionId = await rows.learning([sourceId]), conversationId = await rows.conversation();
  const turnId = await rows.turn(conversationId, [sourceId]);
  const observationId = await rows.observation(sessionId, [sourceId], [turnId]);
  const helpId = await rows.help(sessionId, turnId);
  // Old archive rows explicitly populate NULL rather than taking the new column defaults.
  await fixture.sql`UPDATE opening_learning_observations SET root_observation_id=NULL, revises_observation_id=NULL,
    revision_kind=NULL, revision_reason=NULL, actor_id=NULL, effective_head_id=NULL WHERE id=${observationId}`;
  const { tables } = await readOpeningBackupRecords(fixture.sql, fixture.scope);
  expect(tables.opening_learning_observations).toMatchObject([{
    id: observationId, root_observation_id: null, revises_observation_id: null, revision_kind: null,
    revision_reason: null, actor_id: null, effective_head_id: null, source_versions: null, reference_check: null,
  }]);
  expect(tables.opening_learning_attempts).toEqual([]);
  expect(tables.opening_turns).toMatchObject([{ id: turnId }]);
  expect(tables.opening_help_exposures).toMatchObject([{ id: helpId }]);
});
