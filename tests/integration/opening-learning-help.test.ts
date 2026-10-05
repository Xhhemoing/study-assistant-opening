import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => { await fixture.reset(); await fixture.sql`TRUNCATE opening_learning_sessions,opening_conversations CASCADE`; });
afterAll(async () => { await fixture?.close(); });

it("replays delivered help from stored facts, including the inferred problem identity", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const help = await f.help(attempt);
  const replay = await f.learning.insertHelpExposure(fixture.scope, { ...help, problemId: null });

  expect(replay).toEqual(help);
  const [revision] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(revision?.revision)).toBe(help.historyRevision);
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE session_id=${f.sessionId}`).toHaveLength(1);
});

it.each(["level", "turn", "attempt"] as const)("rejects a help exposure ID reused with a different %s", async (field) => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const help = await f.help(attempt);
  const other = field === "level" ? null : await f.help(field === "attempt" ? await f.start() : attempt);
  const changed = field === "level" ? { ...help, level: "revealed" as const }
    : { ...other!, id: help.id };

  await expect(f.learning.insertHelpExposure(fixture.scope, changed)).rejects.toMatchObject({ code: "CONFLICT" });
  const [stored] = await fixture.sql`SELECT turn_id,attempt_id,problem_id,level FROM opening_help_exposures WHERE id=${help.id}`;
  expect(stored).toEqual({ turn_id: help.turnId, attempt_id: attempt.id, problem_id: attempt.problemId, level: "hinted" });
  const [revision] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(revision?.revision)).toBe(other?.historyRevision ?? help.historyRevision);
});

it("rejects delivered help attributed to a different attempt than its completed assistant turn", async () => {
  const f = await learningAttemptFixture(fixture), a = await f.start(), b = await f.start();
  const help = await f.help(a);

  await expect(f.learning.insertHelpExposure(fixture.scope, {
    ...help, id: randomUUID(), attemptId: b.id, problemId: b.problemId,
  })).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE attempt_id=${b.id}`).toHaveLength(0);
  const [revision] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(revision?.revision)).toBe(help.historyRevision);
});

it("keeps a problem-free attempt null and rejects a supplied problem identity", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start({ problem: undefined });
  expect(attempt.problemId).toBeNull();
  const help = await f.help(attempt);
  expect(help.problemId).toBeNull();
  await expect(f.learning.insertHelpExposure(fixture.scope, help)).resolves.toEqual(help);

  await expect(f.learning.insertHelpExposure(fixture.scope, {
    ...help, id: randomUUID(), problemId: randomUUID(),
  })).rejects.toMatchObject({ code: "VALIDATION" });
  expect(await fixture.sql`SELECT problem_id FROM opening_help_exposures WHERE attempt_id=${attempt.id}`)
    .toEqual([{ problem_id: null }]);
  const [revision] = await fixture.sql`SELECT revision FROM opening_learning_history_revisions WHERE course_id=${f.courseId}`;
  expect(Number(revision?.revision)).toBe(help.historyRevision);
});

it("requires a readable completed assistant turn before recording delivery", async () => {
  const f = await learningAttemptFixture(fixture), attempt = await f.start();
  const help = await f.help(attempt);
  await fixture.sql`UPDATE opening_turns SET status='failed' WHERE id=${help.turnId}`;

  await expect(f.learning.insertHelpExposure(fixture.scope, { ...help, id: randomUUID() }))
    .rejects.toMatchObject({ code: "VALIDATION" });
  expect(await fixture.sql`SELECT id FROM opening_help_exposures WHERE attempt_id=${attempt.id}`).toHaveLength(1);
});
