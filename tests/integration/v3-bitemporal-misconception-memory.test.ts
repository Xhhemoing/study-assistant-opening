import { createHmac, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyLearnerMisconceptionCorrection,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  executeOpeningRestoreApply,
  readLearnerMisconceptionContextBlock,
  readOpeningBackupRecords,
  readOpeningRestoreNamespaceCounts,
  readTryMisconceptionHandoffClock,
  queryMisconceptionEdgesAsOf,
  type OpeningScope,
} from "@aistudy/database";
import { composeOpeningBackupDraft, validateOpeningRestore, type OpeningBackup } from "@aistudy/domain";
import { POST as redeem, PUT as issue } from "../../apps/web/src/app/api/opening/public-try/misconception-handoff/route";
import { POST as correct } from "../../apps/web/src/app/api/opening/memory/bitemporal-correction/route";
import { issueSignedTryMisconceptionReceipt, issueTryMisconceptionReceipt, verifyTryMisconceptionReceipt } from "../../apps/web/src/features/opening/public-try/v3-try-misconception-handoff";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";
import { deferred, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

const secret = "synthetic-receipt-secret-with-32-characters";
const selection = { challenge: "limit", step: 0, reason: 0 };
let f: OpeningFixture;
let authRuntime: ReturnType<typeof createAuthRuntime> | undefined;
let otherCookie: string;

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  f = await createOpeningFixture();
  authRuntime = createAuthRuntime({
    databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: secret,
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(authRuntime);
  const { token } = await authRuntime.sessions.issue({ userId: f.otherScope.ownerUserId, workspaceId: f.otherScope.workspaceId });
  otherCookie = "aistudy_session=" + token;
});
afterEach(async () => {
  setAuthRuntimeForTests(null);
  vi.unstubAllEnvs();
  await authRuntime?.close();
  await f?.close();
});

const validAt = "2026-11-01T00:00:00Z";

function tryRequest(method: "PUT" | "POST", body: unknown, owner = "primary") {
  return new Request("http://opening-fixture.test/api/opening/public-try/misconception-handoff", {
    method, body: JSON.stringify(body), headers: method === "POST" ? { cookie: owner === "other" ? otherCookie : f.cookie } : undefined,
  });
}

function withDifferentSignedSummary(receipt: string): string {
  return rewriteSignedReceipt(receipt, () => ({ summary: "Different signed payload" }));
}

function rewriteSignedReceipt(receipt: string, changes: (payload: { issuedAt: number; expiresAt: number }) => Record<string, unknown>): string {
  const payload = JSON.parse(Buffer.from(receipt.split(".")[0]!, "base64url").toString("utf8"));
  const changed = Buffer.from(JSON.stringify({ ...payload, ...changes(payload) })).toString("base64url");
  const signature = createHmac("sha256", secret).update("opening:try-misconception:v2." + changed).digest("base64url");
  return changed + "." + signature;
}

async function seedEdge({
  scope = f.scope, edgeId = randomUUID(), courseId = null, evidenceAttemptIds = [], future = false,
  origin = "system_diagnosis", summary = "Initial diagnosis", priorRevisionId = null, status = "verified", privacyEpoch = 0,
}: { scope?: OpeningScope; edgeId?: string; courseId?: string | null; evidenceAttemptIds?: string[]; future?: boolean;
  origin?: string; summary?: string; priorRevisionId?: string | null; status?: string; privacyEpoch?: number } = {}) {
  const [row] = await f.sql<{ edgeId: string; revisionId: string; txAt: string }[]>`
    INSERT INTO v3_bitemporal_misconception_edges
      (revision_id, workspace_id, owner_user_id, edge_id, course_id, concept_key, misconception_code, summary, status, origin,
       evidence_attempt_ids, privacy_epoch, valid_range, tx_range, prior_revision_id)
    VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${courseId},
      'limit', 'conditions', ${summary}, ${status}, ${origin}, ${evidenceAttemptIds}::uuid[], ${privacyEpoch},
      tstzrange('2000-01-01Z'::timestamptz, NULL, '[)'),
      tstzrange(clock_timestamp() + CASE WHEN ${future} THEN interval '5 seconds' ELSE interval '0' END, NULL, '[)'), ${priorRevisionId})
    RETURNING edge_id AS "edgeId", revision_id AS "revisionId", lower(tx_range)::text AS "txAt"`;
  return row!;
}

it("enforces GiST overlap and global edge identity, and rejects historical row edits", async () => {
  const first = await seedEdge();
  const [extension] = await f.sql`SELECT extname FROM pg_extension WHERE extname='btree_gist'`;
  expect(extension?.extname).toBe("btree_gist");
  await expect(seedEdge({ edgeId: first.edgeId })).rejects.toMatchObject({
    code: "23P01", constraint_name: "v3_misconception_no_overlap",
  });
  await expect(seedEdge({ edgeId: first.edgeId, scope: f.otherScope })).rejects.toMatchObject({ code: "23P01" });
  await expect(f.sql`UPDATE v3_bitemporal_misconception_edges SET summary='changed' WHERE revision_id=${first.revisionId}`)
    .rejects.toMatchObject({ code: "23514" });

  const otherCourse = randomUUID();
  await f.sql`INSERT INTO courses(id, workspace_id, title, slug)
    VALUES (${otherCourse}, ${f.otherScope.workspaceId}, 'Foreign course', ${otherCourse})`;
  await expect(seedEdge({ courseId: otherCourse })).rejects.toMatchObject({
    code: "23503", constraint_name: "v3_misconception_course_scope",
  });
});

it("rejects a verified public handoff at the database boundary", async () => {
  await expect(seedEdge({ origin: "public_try_handoff" })).rejects.toMatchObject({
    code: "23514", constraint_name: "v3_misconception_public_try_candidate",
  });
});

it("rejects self-referencing and cyclic revision predecessors at the database boundary", async () => {
  const { sql, scope } = f;
  const edgeId = randomUUID();
  const a = randomUUID(), b = randomUUID();
  const insert = (revisionIds: string[], priorIds: string[]) => sql`
    INSERT INTO v3_bitemporal_misconception_edges
      (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code, summary, status, origin,
       valid_range, tx_range, prior_revision_id)
    SELECT r.id, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, 'limit', 'conditions', 'Cyclic diagnosis',
      'verified', 'system_diagnosis', tstzrange('2000-01-01Z', NULL, '[)'),
      tstzrange(to_timestamp(r.position), to_timestamp(r.position + 1), '[)'), r.prior
    FROM unnest(${revisionIds}::uuid[], ${priorIds}::uuid[]) WITH ORDINALITY AS r(id, prior, position)`;
  await expect(insert([a], [a])).rejects.toMatchObject({
    code: "23514", constraint_name: "v3_misconception_no_self_predecessor",
  });
  await expect(insert([a, b], [b, a])).rejects.toMatchObject({
    code: "23514", constraint_name: "v3_misconception_acyclic_predecessors",
  });
  expect(await sql`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${edgeId}`).toEqual([]);
});

it("omits the entire diagnosis lineage when an attempt's source is excluded from backup", async () => {
  const { sql, scope } = f;
  const learning = await learningAttemptFixture(f);
  const attempt = await learning.start();
  const diagnosis = await seedEdge({ courseId: learning.courseId, evidenceAttemptIds: [attempt.id], summary: "Private diagnosis" });
  // A revision with no evidence still depends on the excluded predecessor.
  await sql`UPDATE v3_bitemporal_misconception_edges SET tx_range =
    tstzrange(lower(tx_range), GREATEST(clock_timestamp(), lower(tx_range) + interval '1 microsecond'), '[)')
    WHERE revision_id=${diagnosis.revisionId}`;
  const later = await seedEdge({ edgeId: diagnosis.edgeId, courseId: learning.courseId, priorRevisionId: diagnosis.revisionId });
  const independent = await seedEdge({ summary: "Independent diagnosis" });
  const before = await readOpeningBackupRecords(sql, scope);
  expect(before.tables.opening_learning_attempts).toMatchObject([{ id: attempt.id }]);
  expect(before.tables.v3_bitemporal_misconception_edges.map(row => row.revision_id))
    .toEqual([diagnosis.revisionId, independent.revisionId, later.revisionId]);
  await sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES (${scope.workspaceId},${learning.sourceId})`;
  const filtered = await readOpeningBackupRecords(sql, scope);
  expect(filtered.tables.opening_learning_attempts).toEqual([]);
  expect(filtered.tables.v3_bitemporal_misconception_edges).toMatchObject([{ revision_id: independent.revisionId }]);
});

it("keeps exact valid time, historical reads and both L1 ledgers when the learner disputes an edge", async () => {
  const { sql, scope } = f;
  const courseId = randomUUID();
  await sql`INSERT INTO courses(id, workspace_id, title, slug) VALUES (${courseId}, ${scope.workspaceId}, 'Test course', ${courseId})`;
  const learning = createOpeningLearningRepository(sql);
  const session = await learning.createSession(scope, { courseId, skillLabel: "limits", sourceIds: [] });
  const attempt = await createOpeningLearningAttemptRepository(sql).create(scope, { sessionId: session.id, clientKey: randomUUID() });
  await learning.insertObservation(scope, {
    sessionId: session.id, courseId, skillLabel: "limits", sourceIds: [], attemptId: attempt.id, problemId: attempt.problemId,
    clientKey: randomUUID(), answer: "Test answer", outcome: "unverified", assistance: "independent", verdictSource: "self_report",
  });
  const snapshot = () => sql`SELECT
    (SELECT to_jsonb(a) FROM opening_learning_attempts a WHERE id=${attempt.id}) AS attempt,
    (SELECT to_jsonb(o) FROM opening_learning_observations o WHERE attempt_id=${attempt.id}) AS observation`;
  const before = await snapshot();
  expect(before[0]).toMatchObject({ attempt: { id: attempt.id }, observation: { attempt_id: attempt.id } });

  const first = await seedEdge({ courseId, evidenceAttemptIds: [attempt.id] });
  const summary = "汉🧠".repeat(1000);
  const payload = { edgeId: first.edgeId, disposition: "disputed", summary } as const;
  const request = (owner: string, body: unknown = payload) =>
    new Request("http://opening-fixture.test/api/opening/memory/bitemporal-correction", {
      method: "POST", body: JSON.stringify(body), headers: { cookie: owner === "other" ? otherCookie : f.cookie },
    });
  expect((await correct(request("other"))).status).toBe(404);
  expect((await correct(request("primary", { ...payload, status: "verified" }))).status).toBe(400);
  const response = await correct(request("primary"));
  expect(response.status).toBe(200);
  const correction = await response.json();
  const originalQuery = { validAt, txAt: first.txAt, courseId, expectedPrivacyEpoch: 0 };
  const [original] = await queryMisconceptionEdgesAsOf(sql, scope, originalQuery);
  const newQuery = { ...originalQuery, txAt: correction.txAt };
  const [edited] = await queryMisconceptionEdgesAsOf(sql, scope, newQuery);
  expect(original).toMatchObject({ revisionId: first.revisionId, status: "verified", summary: "Initial diagnosis" });
  expect(edited).toMatchObject({
    revisionId: correction.revisionId, priorRevisionId: first.revisionId, summary, validRange: original!.validRange,
    status: "learner_reported", origin: "learner_correction", learnerDisposition: "disputed", evidenceAttemptIds: [attempt.id],
  });
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { ...newQuery, courseId: randomUUID() })).resolves.toEqual([]);
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { ...newQuery, expectedPrivacyEpoch: 1 })).resolves.toEqual([]);
  await expect(queryMisconceptionEdgesAsOf(sql, f.otherScope, newQuery)).resolves.toEqual([]);
  expect(await snapshot()).toEqual(before);

  const [block] = await sql`SELECT rendered_markdown, byte_length, octet_length(rendered_markdown) AS actual_bytes
    FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  expect(block!.byte_length).toBe(block!.actual_bytes);
  expect(block!.byte_length).toBeGreaterThanOrEqual(2045);
  expect(block!.byte_length).toBeLessThanOrEqual(2048);
  expect(block!.rendered_markdown).toMatch(/^- 学习者提出异议：(?:汉🧠)+汉?$/u);
  await expect(sql`UPDATE v3_learner_context_blocks
    SET rendered_markdown=repeat('🧠', 513), byte_length=2052 WHERE workspace_id=${scope.workspaceId}`)
    .rejects.toMatchObject({ code: "23514" });
});

it("uses fresh post-lock transaction time and advances rapid revisions by at least one microsecond", async () => {
  const { sql, scope } = f;
  const released = await seedEdge();
  const writer = await openRaceSession().ready;
  const reader = await openRaceSession().ready;
  let correction: ReturnType<typeof applyLearnerMisconceptionCorrection> | undefined;
  let context: ReturnType<typeof readLearnerMisconceptionContextBlock> | undefined;
  try {
    const releasedAt = await sql.begin(async tx => {
      await tx`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE revision_id=${released.revisionId} FOR UPDATE`;
      const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      correction = track(applyLearnerMisconceptionCorrection(writer.sql, scope,
        { edgeId: released.edgeId, disposition: "clarified", summary: "After the row lock" }));
      await waitUntilBlocked(sql, writer.pid, holder!.pid, "correction waits for edge lock",
        /FROM v3_bitemporal_misconception_edges[\s\S]+FOR NO KEY UPDATE/);
      context = track(readLearnerMisconceptionContextBlock(reader.sql, scope));
      await waitUntilBlocked(sql, reader.pid, writer.pid, "context waits for workspace before reading revisions",
        /FROM workspaces[\s\S]+FOR SHARE/);
      const [clock] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
      return clock!.at;
    });
    const result = await correction!;
    const [time] = await sql`SELECT ${result.txAt}::text::timestamptz >= ${releasedAt}::text::timestamptz AS after_lock`;
    expect(time!.after_lock).toBe(true);
    await expect(context).resolves.toEqual(result.contextBlock);
  } finally {
    await correction?.catch(() => undefined);
    await context?.catch(() => undefined);
    await reader.sql.end({ timeout: 5 });
    await writer.sql.end({ timeout: 5 });
  }

  const future = await seedEdge({ future: true });
  const apply = (summary: string) => applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId: future.edgeId, disposition: "clarified", summary });
  await apply("Sequential");
  const concurrent = await Promise.all([apply("Concurrent A"), apply("Concurrent B")]);
  expect(new Set(concurrent.map(row => row.revisionId)).size).toBe(2);
  const revisions = await sql`SELECT revision_id, prior_revision_id, upper_inf(tx_range) AS open,
    NOT isempty(tx_range) AS nonempty,
    extract(epoch FROM (lower(tx_range) - ${future.txAt}::text::timestamptz)) * 1000000 AS elapsed_us
    FROM v3_bitemporal_misconception_edges WHERE edge_id=${future.edgeId} ORDER BY lower(tx_range)`;
  expect(revisions.map(row => Number(row.elapsed_us))).toEqual([0, 1, 2, 3]);
  expect(revisions.every(row => row.nonempty)).toBe(true);
  expect(revisions.map(row => row.open)).toEqual([false, false, false, true]);
  expect(revisions.slice(1).map(row => row.prior_revision_id)).toEqual(revisions.slice(0, -1).map(row => row.revision_id));
});

function pauseBeforeRevisionLock(sql: Sql) {
  const paused = deferred();
  const resume = deferred();
  const gated = {
    begin: (run: (tx: TransactionSql) => Promise<unknown>) => sql.begin(tx => run(new Proxy(tx, {
      apply(target, thisArg, args) {
        if (Array.isArray(args[0]) && /SELECT revision_id FROM v3_bitemporal_misconception_edges[\s\S]+FOR NO KEY UPDATE/.test(args[0].join(" "))) {
          paused.resolve();
          return resume.promise.then(() => Reflect.apply(target, thisArg, args));
        }
        return Reflect.apply(target, thisArg, args);
      },
    }))),
  };
  return { sql: gated as unknown as Sql, paused: paused.promise, resume: resume.resolve };
}

function closeRevision(sql: Sql | TransactionSql, revisionId: string) {
  return sql`UPDATE v3_bitemporal_misconception_edges SET tx_range =
    tstzrange(lower(tx_range), GREATEST(clock_timestamp(), lower(tx_range) + interval '1 microsecond'), '[)')
    WHERE revision_id=${revisionId} RETURNING revision_id`;
}

it("defers context invalidation while an inserting transaction closes another revision", async () => {
  const { sql, scope } = f;
  const existing = await seedEdge();
  const writer = await openRaceSession().ready;
  const gate = pauseBeforeRevisionLock(writer.sql);
  let correction: ReturnType<typeof applyLearnerMisconceptionCorrection> | undefined;
  try {
    await sql.begin(async tx => {
      const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx`INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code,
         summary, status, origin, valid_range, tx_range)
        SELECT ${randomUUID()}, workspace_id, owner_user_id, ${randomUUID()}, concept_key, misconception_code,
          'Concurrent diagnosis', status, origin, valid_range, tx_range
        FROM v3_bitemporal_misconception_edges WHERE revision_id=${existing.revisionId}`;
      const [locks] = await tx`SELECT count(*)::int AS advisory FROM pg_locks
        WHERE pid=${holder!.pid} AND locktype='advisory' AND granted`;
      expect(locks?.advisory).toBe(0);
      correction = track(applyLearnerMisconceptionCorrection(gate.sql, scope,
        { edgeId: existing.edgeId, disposition: "clarified", summary: "Concurrent correction" }));
      await Promise.race([gate.paused, correction]);
      const [closed] = await closeRevision(tx, existing.revisionId);
      expect(closed?.revision_id).toBe(existing.revisionId);
    });
    gate.resume();
    await expect(correction).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readLearnerMisconceptionContextBlock(sql, scope))
      .resolves.toMatchObject({ renderedMarkdown: "- 已确认：Concurrent diagnosis" });
  } finally {
    gate.resume();
    await correction?.catch(() => undefined);
    await writer.sql.end({ timeout: 5 });
  }
});

it("lets a standalone closure commit while correction holds the workspace lock", async () => {
  const { sql, scope } = f;
  const existing = await seedEdge();
  const writer = await openRaceSession().ready;
  const closer = await openRaceSession().ready;
  const gate = pauseBeforeRevisionLock(writer.sql);
  const correction = track(applyLearnerMisconceptionCorrection(gate.sql, scope,
    { edgeId: existing.edgeId, disposition: "clarified", summary: "Concurrent correction" }));
  let committed = false;
  let closure: Promise<unknown> | undefined;
  try {
    await Promise.race([gate.paused, correction]);
    closure = track(closeRevision(closer.sql, existing.revisionId).then(rows => {
      committed = true;
      return rows;
    }));
    await vi.waitFor(async () => {
      if (committed) return;
      const [wait] = await sql`SELECT ${writer.pid} = ANY(pg_blocking_pids(${closer.pid})) AS blocked`;
      if (!wait?.blocked) throw new Error("Closure has neither committed nor reached its lock wait");
    }, { timeout: 5000, interval: 40 });
    // Releasing correction here reproduces the previous cycle if closure is still waiting.
    gate.resume();
    await expect(closure).resolves.toEqual([{ revision_id: existing.revisionId }]);
    await expect(correction).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    gate.resume();
    await Promise.allSettled([correction, closure]);
    await closer.sql.end({ timeout: 5 });
    await writer.sql.end({ timeout: 5 });
  }
});

it("lets a course cascade complete before correction can lock its revision", async () => {
  const { sql, scope } = f;
  const courseId = randomUUID();
  await sql`INSERT INTO courses(id, workspace_id, title, slug)
    VALUES (${courseId}, ${scope.workspaceId}, 'Concurrent cascade', ${courseId})`;
  const existing = await seedEdge({ courseId });
  await readLearnerMisconceptionContextBlock(sql, scope);
  const writer = await openRaceSession().ready;
  let correction: ReturnType<typeof applyLearnerMisconceptionCorrection> | undefined;
  let blockedQuery: string | undefined;
  try {
    await sql.begin(async tx => {
      const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT id FROM courses WHERE id=${courseId} FOR UPDATE`;
      correction = track(applyLearnerMisconceptionCorrection(writer.sql, scope,
        { edgeId: existing.edgeId, disposition: "clarified", summary: "Concurrent correction" }));
      await waitUntilBlocked(sql, writer.pid, holder!.pid, "correction waits for the course delete transaction");
      const [blocked] = await sql<{ query: string }[]>`SELECT query FROM pg_stat_activity WHERE pid=${writer.pid}`;
      blockedQuery = blocked?.query;
      await tx`DELETE FROM courses WHERE id=${courseId}`;
    });
    await expect(correction).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(blockedQuery).toMatch(/FROM courses[\s\S]+FOR KEY SHARE/);
    await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toMatchObject({ renderedMarkdown: "", revision: 2 });
  } finally {
    await correction?.catch(() => undefined);
    await writer.sql.end({ timeout: 5 });
  }
});

it("corrects an edge while a concurrent successor insert holds a predecessor key share", async () => {
  const { sql, scope } = f;
  const edgeId = randomUUID();
  const orderedIds = [randomUUID(), randomUUID()].sort();
  const earlierId = orderedIds[0]!;
  const currentId = orderedIds[1]!;
  const concurrentId = randomUUID();
  await sql`INSERT INTO v3_bitemporal_misconception_edges
    (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code,
      summary, status, origin, valid_range, tx_range)
    SELECT slice.id, ${scope.workspaceId}::uuid, ${scope.ownerUserId}::uuid, ${edgeId}::uuid,
      'limit', 'conditions', 'Diagnosis', 'verified', 'system_diagnosis', slice.valid_range,
      tstzrange(clock_timestamp(), NULL, '[)')
    FROM (VALUES
      (${earlierId}::uuid, tstzrange('1999-01-01Z', '2000-01-01Z', '[)')),
      (${currentId}::uuid, tstzrange('2000-01-01Z', '2100-01-01Z', '[)'))
    ) AS slice(id, valid_range)`;
  const writer = await openRaceSession().ready;
  let correction: ReturnType<typeof applyLearnerMisconceptionCorrection> | undefined;
  let corrected = false;
  try {
    await sql.begin(async tx => {
      const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx`INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code,
          summary, status, origin, valid_range, tx_range, prior_revision_id)
        SELECT ${concurrentId}, workspace_id, owner_user_id, edge_id, concept_key, misconception_code,
          'Future diagnosis', status, origin, tstzrange('2100-01-01Z', NULL, '[)'), tx_range, revision_id
        FROM v3_bitemporal_misconception_edges WHERE revision_id=${currentId}`;
      correction = track(applyLearnerMisconceptionCorrection(writer.sql, scope,
        { edgeId, disposition: "clarified", summary: "Concurrent correction" }).then(result => {
        corrected = true;
        return result;
      }));
      await vi.waitFor(async () => {
        if (corrected) return;
        const [wait] = await sql`SELECT ${holder!.pid} = ANY(pg_blocking_pids(${writer.pid})) AS blocked`;
        if (!wait?.blocked) throw new Error("Correction has neither committed nor reached its lock wait");
      }, { timeout: 5000, interval: 40 });
      // The old prelock waits on the predecessor while holding the earlier row, so closing it completes the cycle.
      const [closed] = await closeRevision(tx, earlierId);
      expect(closed?.revision_id).toBe(earlierId);
    });
    const result = await correction!;
    const [successor] = await sql`SELECT prior_revision_id FROM v3_bitemporal_misconception_edges
      WHERE revision_id=${result.revisionId}`;
    expect(successor?.prior_revision_id).toBe(currentId);
  } finally {
    await correction?.catch(() => undefined);
    await writer.sql.end({ timeout: 5 });
  }
});

it("issues and redeems one signed candidate under concurrent retries and rejects conflicting claims and expiry", async () => {
  const issuance = await issue(tryRequest("PUT", selection));
  expect(issuance.status).toBe(201);
  const { receipt } = await issuance.json();
  const responses = await Promise.all([redeem(tryRequest("POST", { receipt })), redeem(tryRequest("POST", { receipt }))]);
  const first = responses.find(response => response.status === 201)!;
  const replay = responses.find(response => response.status === 200)!;
  const created = await first.json();
  expect(created.replayed).toBe(false);
  expect(await replay.json()).toEqual({ ...created, replayed: true });
  expect((await redeem(tryRequest("POST", { receipt }, "other"))).status).toBe(409);

  expect((await redeem(tryRequest("POST", { receipt: withDifferentSignedSummary(receipt) }))).status).toBe(409);
  const tick = await readTryMisconceptionHandoffClock(f.sql);
  const expired = issueTryMisconceptionReceipt(selection, secret, { ...tick, nowMs: tick.nowMs - 900_000 });
  expect((await redeem(tryRequest("POST", { receipt: expired }))).status).toBe(409);

  const rows = await f.sql`SELECT revision_id, edge_id, status, origin, evidence_attempt_ids
    FROM v3_bitemporal_misconception_edges WHERE workspace_id=${f.scope.workspaceId}`;
  expect(rows).toEqual([{
    revision_id: created.revisionId, edge_id: created.edgeId, status: "candidate", origin: "public_try_handoff", evidence_attempt_ids: [],
  }]);
  const claims = await f.sql`SELECT initial_revision_id FROM v3_try_misconception_handoff_receipts
    WHERE workspace_id=${f.scope.workspaceId}`;
  expect(claims).toEqual([{ initial_revision_id: created.revisionId }]);
  const [block] = await f.sql`SELECT revision, rendered_markdown FROM v3_learner_context_blocks WHERE workspace_id=${f.scope.workspaceId}`;
  expect(block).toMatchObject({ revision: 1, rendered_markdown: expect.stringContaining("待确认") });

  const contested = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  const race = await Promise.all([
    redeem(tryRequest("POST", { receipt: contested })), redeem(tryRequest("POST", { receipt: contested }, "other")),
  ]);
  expect(race.map(result => result.status).sort()).toEqual([201, 409]);
});

it("enforces owner binding on all three tables and preserves course and workspace cascades", async () => {
  const { sql, scope, otherScope } = f;
  await expect(seedEdge({ scope: { ...scope, ownerUserId: otherScope.ownerUserId } })).rejects.toMatchObject({
    code: "23503", constraint_name: "v3_misconception_workspace_owner",
  });
  await expect(sql`INSERT INTO v3_learner_context_blocks
    (workspace_id, owner_user_id, rendered_markdown, byte_length, revision, privacy_epoch, updated_at)
    VALUES (${scope.workspaceId}, ${otherScope.ownerUserId}, '', 0, 1, 0, clock_timestamp())`)
    .rejects.toMatchObject({ code: "23503", constraint_name: "v3_learner_context_workspace_owner" });

  const courseId = randomUUID();
  await sql`INSERT INTO courses(id, workspace_id, title, slug)
    VALUES (${courseId}, ${scope.workspaceId}, 'Cascade fixture', ${courseId})`;
  const independent = await seedEdge({ summary: "Independent diagnosis" });
  const first = await seedEdge({ courseId });
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toMatchObject({ revision: 1 });
  const correction = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId: first.edgeId, disposition: "clarified", summary: "Course correction" });
  expect(correction.contextBlock.renderedMarkdown).toContain("Course correction");
  const receiptId = randomUUID();
  const insertReceipt = (ownerId: string) => sql`INSERT INTO v3_try_misconception_handoff_receipts
    (receipt_id, original_workspace_id, original_owner_user_id, redeemed_privacy_epoch, workspace_id, owner_user_id, payload_sha256, edge_id, initial_revision_id, redeemed_at)
    VALUES (${receiptId}, ${scope.workspaceId}, ${ownerId}, 0, ${scope.workspaceId}, ${ownerId}, ${"a".repeat(64)}, ${first.edgeId}, ${first.revisionId}, clock_timestamp())`;
  await expect(insertReceipt(otherScope.ownerUserId)).rejects.toMatchObject({
    code: "23503", constraint_name: "v3_try_misconception_initial_scope",
  });
  await insertReceipt(scope.ownerUserId);
  await expect(sql`DELETE FROM v3_bitemporal_misconception_edges WHERE edge_id=${first.edgeId}`)
    .rejects.toMatchObject({ code: "23514" });
  expect(await sql`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${first.edgeId}`).toHaveLength(2);
  await sql`DELETE FROM courses WHERE id=${courseId}`;
  const invalidated = await sql`SELECT *, octet_length(rendered_markdown) AS rendered_bytes
    FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`;
  expect(await sql`SELECT edge_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${first.edgeId}`).toEqual([]);
  expect(await sql`SELECT workspace_id, edge_id, initial_revision_id FROM v3_try_misconception_handoff_receipts
    WHERE receipt_id=${receiptId}`).toEqual([{ workspace_id: null, edge_id: null, initial_revision_id: null }]);
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toMatchObject({
    renderedMarkdown: "- 已确认：Independent diagnosis", revision: 3,
  });
  expect(correction.contextBlock.revision).toBe(2);
  expect(invalidated).toMatchObject([{ invalidated: true, revision: 2, rendered_bytes: 0 }]);
  expect(await sql`SELECT invalidated, revision FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`)
    .toEqual([{ invalidated: false, revision: 3 }]);

  await sql`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
  expect(await sql`SELECT edge_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${independent.edgeId}`).toEqual([]);
  expect(await sql`SELECT revision FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
});

it("omits revoked history from point-in-time queries with or without an expected privacy epoch", async () => {
  const { sql, scope } = f;
  const first = await seedEdge();
  const query = { validAt, txAt: first.txAt };
  await expect(queryMisconceptionEdgesAsOf(sql, scope, query)).resolves.toMatchObject([{ revisionId: first.revisionId }]);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  await expect(queryMisconceptionEdgesAsOf(sql, scope, query)).resolves.toEqual([]);
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { ...query, expectedPrivacyEpoch: 0 })).resolves.toEqual([]);
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { ...query, expectedPrivacyEpoch: 1 })).resolves.toEqual([]);
  const current = await seedEdge({ privacyEpoch: 1 });
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { ...query, txAt: current.txAt }))
    .resolves.toMatchObject([{ revisionId: current.revisionId }]);
});

it("omits revoked misconception lineages from backup while retaining current history", async () => {
  const { sql, scope } = f;
  const old = await seedEdge({ summary: "Revoked diagnosis" });
  await closeRevision(sql, old.revisionId);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  const successor = await seedEdge({ edgeId: old.edgeId, priorRevisionId: old.revisionId, privacyEpoch: 1 });
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { validAt, txAt: successor.txAt }))
    .resolves.toMatchObject([{ revisionId: successor.revisionId, priorRevisionId: null }]);
  const current = await seedEdge({ privacyEpoch: 1 });
  const backup = await readOpeningBackupRecords(sql, scope);
  expect(backup.privacyEpoch).toBe(1);
  expect(backup.tables.v3_bitemporal_misconception_edges.map(row => row.revision_id)).toEqual([current.revisionId]);
});

it.each([
  { name: "skips 2,048 ASCII control-only summaries", summary: "\u0007", count: 2048, expected: "- 待确认：B" },
  { name: "pages past 2,048 Unicode whitespace summaries", summary: "\uFEFF", count: 2048, expected: "- 待确认：B" },
  { name: "stops paging at the byte budget", summary: "A", count: 200, expected: Array(128).fill("- 待确认：A").join("\n") },
])("$name", async ({ summary, count, expected }) => {
  const { sql, scope } = f;
  const visible = await seedEdge({ status: "candidate", summary: "B" });
  await sql`INSERT INTO v3_bitemporal_misconception_edges
    (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code,
      summary, status, origin, valid_range, tx_range)
    SELECT gen_random_uuid(), workspace_id, owner_user_id, gen_random_uuid(), concept_key, misconception_code,
      ${summary}, status, origin, valid_range, tstzrange(lower(tx_range) + interval '1 microsecond', NULL, '[)')
    FROM v3_bitemporal_misconception_edges CROSS JOIN generate_series(1, ${count}::integer) WHERE revision_id=${visible.revisionId}`;
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toMatchObject({
    renderedMarkdown: expected, byteLength: Buffer.byteLength(expected),
  });
});

it("normalizes long whitespace runs before applying the context byte limit", async () => {
  const { sql, scope } = f;
  await seedEdge({ status: "candidate", summary: "A" + " ".repeat(2047) + "B" });
  const expected = "- 待确认：A B";
  const byteLength = Buffer.byteLength(expected);
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toMatchObject({
    renderedMarkdown: expected, byteLength,
  });
  const [block] = await sql`SELECT rendered_markdown, octet_length(rendered_markdown) AS bytes
    FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`;
  expect(block).toEqual({ rendered_markdown: expected, bytes: byteLength });
});

it("renders only edges recorded and valid at the context timestamp", async () => {
  const { sql, scope } = f;
  const future = await seedEdge({ future: true });
  const present = await seedEdge();
  const correction = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId: present.edgeId, disposition: "clarified", summary: "Current diagnosis" });
  expect(correction.contextBlock.renderedMarkdown).toBe("- 学习者补充说明：Current diagnosis");
  const [block] = await sql`SELECT updated_at::text AS at, privacy_epoch FROM v3_learner_context_blocks
    WHERE workspace_id=${scope.workspaceId}`;
  const at = String(block!.at);
  const visible = await queryMisconceptionEdgesAsOf(sql, scope, {
    validAt: at, txAt: at, expectedPrivacyEpoch: Number(block!.privacy_epoch),
  });
  expect(visible.map(row => row.edgeId)).toEqual([present.edgeId]);
  const atFuture = await queryMisconceptionEdgesAsOf(sql, scope, {
    validAt: future.txAt, txAt: future.txAt, expectedPrivacyEpoch: 0,
  });
  expect(atFuture.map(row => row.edgeId)).toContain(future.edgeId);
});

async function exportMisconceptionArchive(): Promise<OpeningBackup> {
  const { sql, scope } = f;
  const records = await readOpeningBackupRecords(sql, scope);
  const composed = composeOpeningBackupDraft({ records, staging: {
    snapshot: { workspaceId: scope.workspaceId, privacyEpoch: records.privacyEpoch,
      deletionJournal: records.deletionJournal, memoryDeletions: records.memoryDeletions, sources: [] },
    objects: [],
  } });
  if (!composed.ok) throw new Error(composed.errors.join(", "));
  return JSON.parse(JSON.stringify(composed.backup));
}

async function recreateEmptyWorkspace(workspaceId = f.scope.workspaceId) {
  const { sql, scope } = f;
  // Opening restore preserves IDs in a clean copy of the original workspace.
  await sql`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
  // The history counter predates this migration and is independent of workspace cascades.
  await sql`DELETE FROM opening_workspace_history_revisions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  await sql`INSERT INTO workspaces(id, owner_user_id) VALUES (${workspaceId}, ${scope.ownerUserId})`;
}

function restoreMisconceptionArchive(backup: OpeningBackup) {
  return executeOpeningRestoreApply(f.sql, { confirmLocalRestore: true, backup,
    currentMemoryDeletions: backup.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] },
  });
}

it("refreshes cached context after valid-time and transaction-time boundaries without a write", async () => {
  const { sql, scope } = f;
  const [boundary] = await sql<{ at: string }[]>`
    SELECT (clock_timestamp() + interval '2 seconds')::text AS at`;
  const at = boundary!.at;
  await sql`INSERT INTO v3_bitemporal_misconception_edges
    (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code, summary, status, origin, valid_range, tx_range)
    VALUES
      (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${randomUUID()}, 'limit', 'conditions',
       'Expiring diagnosis', 'verified', 'system_diagnosis',
       tstzrange('-infinity', ${at}::text::timestamptz, '[)'), tstzrange('-infinity', NULL, '[)')),
      (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${randomUUID()}, 'limit', 'conditions',
       'New diagnosis', 'verified', 'system_diagnosis',
       tstzrange('-infinity', NULL, '[)'), tstzrange(${at}::text::timestamptz, NULL, '[)'))`;
  const first = await readLearnerMisconceptionContextBlock(sql, scope);
  expect(first).toMatchObject({ renderedMarkdown: "- 已确认：Expiring diagnosis", revision: 1 });
  await sql`SELECT pg_sleep_until(${at}::text::timestamptz)`;
  const after = await readLearnerMisconceptionContextBlock(sql, scope);
  expect(after).toMatchObject({ renderedMarkdown: "- 已确认：New diagnosis", revision: 2 });
  const [persisted] = await sql`SELECT rendered_markdown, revision FROM v3_learner_context_blocks
    WHERE workspace_id=${scope.workspaceId}`;
  expect(persisted).toEqual({ rendered_markdown: "- 已确认：New diagnosis", revision: 2 });
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toEqual(after);
});

it("rebuilds a context snapshot that was rendered at a future transaction boundary", async () => {
  const { sql, scope } = f;
  const edge = await seedEdge({ future: true });
  const correction = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId: edge.edgeId, disposition: "clarified", summary: "Future correction" });
  expect(correction.contextBlock.renderedMarkdown).toContain("Future correction");
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toEqual({
    renderedMarkdown: "", byteLength: 0, revision: 2,
  });
});

it("invalidates cached context after a retroactive transaction closure or insert", async () => {
  const { sql, scope } = f;
  const initial = await seedEdge();
  const first = await readLearnerMisconceptionContextBlock(sql, scope);
  expect(first?.renderedMarkdown).toBe("- 已确认：Initial diagnosis");
  const readCache = () => sql<{ updated_at: string; rendered_markdown: string; invalidated: boolean; revision: number }[]>`
    SELECT updated_at::text, rendered_markdown, invalidated, revision FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`;
  const [snapshot] = await readCache();

  const [closed] = await sql`UPDATE v3_bitemporal_misconception_edges
    SET tx_range = tstzrange(lower(tx_range), lower(tx_range) + interval '1 microsecond', '[)')
    WHERE revision_id=${initial.revisionId}
    RETURNING upper(tx_range) < ${snapshot!.updated_at}::text::timestamptz AS closed_before_snapshot`;
  expect(closed?.closed_before_snapshot).toBe(true);
  const cacheAfterClosure = await readCache();
  await expect(readLearnerMisconceptionContextBlock(sql, scope)).resolves.toMatchObject({ renderedMarkdown: "", byteLength: 0, revision: 2 });
  expect(cacheAfterClosure).toMatchObject([{ invalidated: true, revision: 1 }]);

  await sql`INSERT INTO v3_bitemporal_misconception_edges
    (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code,
     summary, status, origin, valid_range, tx_range)
    SELECT ${randomUUID()}, workspace_id, owner_user_id, ${randomUUID()}, concept_key, misconception_code,
      'Backdated diagnosis', status, origin, valid_range, tstzrange(lower(tx_range), NULL, '[)')
    FROM v3_bitemporal_misconception_edges WHERE revision_id=${initial.revisionId}`;
  const cacheAfterInsert = await readCache();
  await expect(readLearnerMisconceptionContextBlock(sql, scope))
    .resolves.toMatchObject({ renderedMarkdown: "- 已确认：Backdated diagnosis", revision: 3 });
  expect(cacheAfterInsert).toMatchObject([{ invalidated: true, revision: 2 }]);
});

it("rejects a course change on the same edge at the database and restore boundaries", async () => {
  const { sql, scope } = f;
  const course = randomUUID(), otherCourse = randomUUID();
  await sql`INSERT INTO courses(id, workspace_id, title, slug) VALUES
    (${course}, ${scope.workspaceId}, 'First course', ${course}),
    (${otherCourse}, ${scope.workspaceId}, 'Second course', ${otherCourse})`;
  const root = await seedEdge({ courseId: course });
  await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId: root.edgeId, disposition: "clarified", summary: "Course correction" });
  const archive = await exportMisconceptionArchive();
  expect(validateOpeningRestore(archive, [], archive.memoryDeletions).allowed).toBe(true);
  const correction = archive.tables.v3_bitemporal_misconception_edges![1] as Record<string, unknown>;
  expect(correction).toMatchObject({ course_id: course, prior_revision_id: root.revisionId });
  for (const [changedCourse, constraint] of [
    [null, "v3_misconception_course_nullability"],
    [otherCourse, "v3_misconception_single_course"],
  ] as const) {
    correction.course_id = changedCourse;
    expect(validateOpeningRestore(archive, [], archive.memoryDeletions)).toMatchObject({
      allowed: false, errors: expect.arrayContaining(["invalid misconception revision lineage"]),
    });
    await expect(restoreMisconceptionArchive(archive)).resolves.toMatchObject({
      ok: false, code: "PREFLIGHT_REJECTED", mutated: false,
    });
    // Non-overlapping valid time isolates the course constraint from range exclusion.
    await expect(sql`INSERT INTO v3_bitemporal_misconception_edges
      (revision_id, workspace_id, owner_user_id, edge_id, course_id, prior_revision_id, concept_key, misconception_code,
       summary, status, origin, learner_disposition, valid_range, tx_range)
      VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${root.edgeId}, ${changedCourse}, ${root.revisionId},
        'limit', 'conditions', 'Changed course', 'learner_reported', 'learner_correction', 'clarified',
        tstzrange('1900-01-01Z', '1901-01-01Z', '[)'), tstzrange(clock_timestamp(), NULL, '[)'))`)
      .rejects.toMatchObject({ code: "23P01", constraint_name: constraint });
  }
  await sql`DELETE FROM courses WHERE id=${course}`;
  expect(await sql`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${root.edgeId}`).toEqual([]);
});

it("rejects receipts whose revoked roots were omitted by restore and accepts fresh receipts", async () => {
  const { sql, scope, otherScope } = f;
  const receipt = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  if (!receipt) throw new Error("Expected a receipt for the fixture selection");
  expect((await redeem(tryRequest("POST", { receipt }))).status).toBe(201);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  const archive = await exportMisconceptionArchive();
  expect(archive.tables.v3_bitemporal_misconception_edges).toEqual([]);
  await recreateEmptyWorkspace();
  const { receiptId } = verifyTryMisconceptionReceipt(receipt, secret);
  expect(await sql`SELECT workspace_id, owner_user_id, edge_id, initial_revision_id
    FROM v3_try_misconception_handoff_receipts WHERE receipt_id=${receiptId}`)
    .toEqual([{ workspace_id: null, owner_user_id: null, edge_id: null, initial_revision_id: null }]);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  const restored = await restoreMisconceptionArchive(archive);
  const fresh = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  if (!fresh) throw new Error("Expected a fresh receipt for the fixture selection");
  expect(restored).toMatchObject({ ok: true });

  const replay = await redeem(tryRequest("POST", { receipt }));
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "CONFLICT" } });
  const foreignReplay = await redeem(tryRequest("POST", { receipt }, "other"));
  expect(foreignReplay.status).toBe(409);
  expect(await foreignReplay.json()).toMatchObject({ error: { code: "CONFLICT" } });
  const revisions = () => sql`SELECT revision_id, privacy_epoch FROM v3_bitemporal_misconception_edges WHERE workspace_id=${scope.workspaceId}`;
  const claims = () => sql`SELECT initial_revision_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`;
  const cutoff = () => sql`SELECT restore_cutoff_seq::text FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`;
  expect(await revisions()).toEqual([]);
  expect(await claims()).toEqual([]);
  const otherEdges = () => sql`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE workspace_id=${otherScope.workspaceId}`;
  expect(await otherEdges()).toEqual([]);
  const restoreStamp = await cutoff();
  expect(restoreStamp).toEqual([{ restore_cutoff_seq: expect.stringMatching(/^\d+$/) }]);

  const firstUse = await redeem(tryRequest("POST", { receipt: fresh }));
  expect(firstUse.status).toBe(201);
  const result = await firstUse.json();
  expect(result).toMatchObject({ replayed: false });
  expect(await revisions()).toEqual([{ revision_id: result.revisionId, privacy_epoch: 1 }]);
  expect(await claims()).toEqual([{ initial_revision_id: result.revisionId }]);
  expect(await cutoff()).toEqual(restoreStamp);
  const otherFresh = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  const otherUse = await redeem(tryRequest("POST", { receipt: otherFresh }, "other"));
  expect(otherUse.status).toBe(201);
  const otherResult = await otherUse.json();
  expect(otherResult.replayed).toBe(false);
  expect(await otherEdges()).toEqual([{ revision_id: otherResult.revisionId }]);
});

it.each([-30_000, 30_000])("orders issuance and restore across database sessions with Node offset by %i ms", async skew => {
  const { sql, scope } = f;
  const archive = await exportMisconceptionArchive();
  const issuer = await openRaceSession().ready;
  const realNow = Date.now;
  const nodeClock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  try {
    const old = (await issueSignedTryMisconceptionReceipt(issuer.sql, selection, secret))!;
    const oldClaim = verifyTryMisconceptionReceipt(old, secret);
    expect(Math.abs(Date.now() - oldClaim.issuedAt)).toBeGreaterThan(20_000);
    expect(oldClaim.expiresAt - oldClaim.issuedAt).toBe(900_000);
    expect(await restoreMisconceptionArchive(archive)).toMatchObject({ ok: true });
    const fresh = (await issueSignedTryMisconceptionReceipt(issuer.sql, selection, secret))!;
    const freshClaim = verifyTryMisconceptionReceipt(fresh, secret);
    const [cutoff] = await sql`SELECT restore_cutoff_seq::text FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`;
    expect(oldClaim.issueSeq).toBeLessThan(Number(cutoff!.restore_cutoff_seq));
    expect(freshClaim.issueSeq).toBeGreaterThan(Number(cutoff!.restore_cutoff_seq));

    const rejected = await redeem(tryRequest("POST", { receipt: old }));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE receipt_id=${oldClaim.receiptId}`).toEqual([]);
    // Use equal signed millisecond timestamps to exercise the sequence tie-break with no timing dependency.
    const sameMsFresh = rewriteSignedReceipt(fresh, () => ({ issuedAt: oldClaim.issuedAt, expiresAt: oldClaim.expiresAt }));
    expect((await redeem(tryRequest("POST", { receipt: sameMsFresh }))).status).toBe(201);

    const expired = await readTryMisconceptionHandoffClock(issuer.sql);
    const expiredReceipt = issueTryMisconceptionReceipt(selection, secret, { ...expired, nowMs: expired.nowMs - 915_000 });
    expect((await redeem(tryRequest("POST", { receipt: expiredReceipt }))).status).toBe(409);
    const nearExpiry = await readTryMisconceptionHandoffClock(issuer.sql);
    const stillValid = issueTryMisconceptionReceipt(selection, secret, { ...nearExpiry, nowMs: nearExpiry.nowMs - 885_000 });
    expect((await redeem(tryRequest("POST", { receipt: stillValid }))).status).toBe(201);
  } finally {
    nodeClock.mockRestore();
    await issuer.sql.end({ timeout: 5 });
  }
});

it.each(["replacement workspace", "later privacy epoch"] as const)(
  "rejects reattachment of a detached receipt to a matching root in a %s", async target => {
    const { sql, scope } = f;
    const receipt = (await issueSignedTryMisconceptionReceipt(sql, selection, secret))!;
    const claim = verifyTryMisconceptionReceipt(receipt, secret);
    const first = await redeem(tryRequest("POST", { receipt }));
    expect(first.status).toBe(201);
    const { edgeId, revisionId } = await first.json();
    const archive = await exportMisconceptionArchive();
    const request = tryRequest("POST", { receipt });
    if (target === "later privacy epoch") {
      await recreateEmptyWorkspace();
      const changed = { ...archive, privacyEpoch: 1, tables: { ...archive.tables,
        v3_bitemporal_misconception_edges: [{ ...archive.tables.v3_bitemporal_misconception_edges![0], privacy_epoch: 1 }],
      } };
      await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
      expect(await restoreMisconceptionArchive(changed)).toMatchObject({ ok: true });
    } else {
      const replacement = randomUUID();
      await recreateEmptyWorkspace(replacement);
      await sql`INSERT INTO v3_bitemporal_misconception_edges
        (revision_id, workspace_id, owner_user_id, edge_id, concept_key, misconception_code, summary, status, origin, valid_range, tx_range)
        VALUES (${revisionId}, ${replacement}, ${scope.ownerUserId}, ${edgeId}, ${claim.conceptKey}, ${claim.misconceptionCode},
          ${claim.summary}, 'candidate', 'public_try_handoff',
          tstzrange('2000-01-01Z', NULL, '[)'), tstzrange('2000-01-01Z', NULL, '[)'))`;
      const { token } = await authRuntime!.sessions.issue({ userId: scope.ownerUserId, workspaceId: replacement });
      request.headers.set("cookie", "aistudy_session=" + token);
    }
    const replay = await redeem(request);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await sql`SELECT original_workspace_id, original_owner_user_id, redeemed_privacy_epoch, workspace_id
      FROM v3_try_misconception_handoff_receipts WHERE receipt_id=${claim.receiptId}`)
      .toEqual([{ original_workspace_id: scope.workspaceId, original_owner_user_id: scope.ownerUserId,
        redeemed_privacy_epoch: 0, workspace_id: null }]);
  },
);

it("retains spent receipt provenance after owner deletion and rejects redemption in another workspace", async () => {
  const { sql, scope, otherScope } = f;
  const receipt = (await issueSignedTryMisconceptionReceipt(sql, selection, secret))!;
  const claim = verifyTryMisconceptionReceipt(receipt, secret);
  expect((await redeem(tryRequest("POST", { receipt }))).status).toBe(201);
  await sql`DELETE FROM users WHERE id=${scope.ownerUserId}`;
  expect(await sql`SELECT id FROM workspaces WHERE id=${scope.workspaceId}`).toEqual([]);
  expect(await sql`SELECT original_workspace_id, original_owner_user_id, redeemed_privacy_epoch, payload_sha256,
    workspace_id, owner_user_id, edge_id, initial_revision_id
    FROM v3_try_misconception_handoff_receipts WHERE receipt_id=${claim.receiptId}`)
    .toEqual([{ original_workspace_id: scope.workspaceId, original_owner_user_id: scope.ownerUserId,
      redeemed_privacy_epoch: 0, payload_sha256: claim.payloadSha256,
      workspace_id: null, owner_user_id: null, edge_id: null, initial_revision_id: null }]);
  const replay = await redeem(tryRequest("POST", { receipt }, "other"));
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "CONFLICT" } });
  expect(await sql`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE workspace_id=${otherScope.workspaceId}`).toEqual([]);
  expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${otherScope.workspaceId}`).toEqual([]);
});

it.each(["ledger", "restored root"])("rejects signed receipt replay from the %s after a privacy epoch advance", async path => {
  const { sql, scope } = f;
  const receipt = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  if (!receipt) throw new Error("Expected a receipt for the fixture selection");
  const response = await redeem(tryRequest("POST", { receipt }));
  expect(response.status).toBe(201);
  const { revisionId } = await response.json();
  if (path === "restored root") {
    const archive = await exportMisconceptionArchive();
    await sql`DELETE FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`;
    await recreateEmptyWorkspace();
    expect(await restoreMisconceptionArchive(archive)).toMatchObject({ ok: true });
  }
  const readClaims = () => sql`SELECT receipt_id, initial_revision_id, payload_sha256, redeemed_at::text
    FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`;
  const claims = await readClaims();
  expect(claims).toHaveLength(path === "ledger" ? 1 : 0);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;

  const replay = await redeem(tryRequest("POST", { receipt }));
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "CONFLICT" } });
  expect(await readClaims()).toEqual(claims);
  expect(await sql`SELECT revision_id, privacy_epoch FROM v3_bitemporal_misconception_edges
    WHERE workspace_id=${scope.workspaceId}`).toEqual([{ revision_id: revisionId, privacy_epoch: 0 }]);
});

it.each(["revision_id", "edge_id"] as const)("rejects a substituted archived root %s on signed receipt replay", async field => {
  const { sql, scope } = f;
  const receipt = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  const original = await redeem(tryRequest("POST", { receipt }));
  expect(original.status).toBe(201);
  const { edgeId, revisionId } = await original.json();
  const archive = await exportMisconceptionArchive();
  const root = archive.tables.v3_bitemporal_misconception_edges![0] as Record<string, unknown>;
  expect(root).toMatchObject({ edge_id: edgeId, revision_id: revisionId });
  root[field] = randomUUID();
  await recreateEmptyWorkspace();
  const restored = await restoreMisconceptionArchive(archive);
  expect(restored, restored.errors.join(", ")).toMatchObject({ ok: true });
  const conflict = await redeem(tryRequest("POST", { receipt }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "CONFLICT" } });
  expect(await sql`SELECT revision_id, edge_id FROM v3_bitemporal_misconception_edges WHERE workspace_id=${scope.workspaceId}`)
    .toEqual([{ edge_id: root.edge_id, revision_id: root.revision_id }]);
  expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
});

it("round-trips misconception corrections through a v1 workspace backup and rebuilds derived context", async () => {
  const { sql, scope } = f;
  const receipt = await issueSignedTryMisconceptionReceipt(f.sql, selection, secret);
  if (!receipt) throw new Error("Expected a receipt for the fixture selection");
  const redeemed = await redeem(tryRequest("POST", { receipt }));
  expect(redeemed.status).toBe(201);
  const { edgeId, revisionId } = await redeemed.json();
  const firstCorrection = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId, disposition: "disputed", summary: "I worked through the limit again" });
  const secondCorrection = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId, disposition: "clarified", summary: "I can explain the condition now" });
  const archive = await exportMisconceptionArchive();
  const rows = archive.tables.v3_bitemporal_misconception_edges as Record<string, unknown>[];
  expect(rows.map(row => row.revision_id)).toEqual([revisionId, firstCorrection.revisionId, secondCorrection.revisionId]);
  expect(archive.tables).not.toHaveProperty("v3_try_misconception_handoff_receipts");
  expect(archive.tables).not.toHaveProperty("v3_learner_context_blocks");
  const forged = structuredClone(archive);
  (forged.tables.v3_bitemporal_misconception_edges![0] as Record<string, unknown>).status = "verified";
  expect(validateOpeningRestore(forged, [], archive.memoryDeletions)).toMatchObject({ allowed: false });
  const exported = [...rows];
  rows.reverse();

  await recreateEmptyWorkspace();
  const counts = await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId);
  expect(counts.v3_bitemporal_misconception_edges).toBe(0);
  const restore = () => restoreMisconceptionArchive(archive);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  await expect(restore()).resolves.toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });
  const mixedEpochArchive = { ...archive, privacyEpoch: 1, tables: { ...archive.tables,
    v3_bitemporal_misconception_edges: [exported[0]!, { ...exported[1]!, privacy_epoch: 1 }],
  } };
  await expect(restoreMisconceptionArchive(mixedEpochArchive)).resolves.toMatchObject({
    ok: false, code: "PREFLIGHT_REJECTED", mutated: false,
    errors: ["misconception revision privacy epoch does not match the archive epoch"],
  });
  expect(await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId)).toEqual(counts);
  await sql`UPDATE workspaces SET privacy_epoch=0 WHERE id=${scope.workspaceId}`;
  const restored = await restore();
  expect(restored, restored.errors.join(", ")).toMatchObject({ ok: true });
  const roundTrip = await readOpeningBackupRecords(sql, scope);
  expect(roundTrip.tables.v3_bitemporal_misconception_edges).toEqual(exported);
  expect((await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId)).v3_bitemporal_misconception_edges).toBe(3);
  const [block] = await sql`SELECT rendered_markdown, byte_length, revision, invalidated FROM v3_learner_context_blocks
    WHERE workspace_id=${scope.workspaceId}`;
  expect(block).toMatchObject({
    rendered_markdown: "- 学习者补充说明：I can explain the condition now", revision: 1, invalidated: false,
  });
  expect(block!.byte_length).toBe(Buffer.byteLength(block!.rendered_markdown));
  expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`).toEqual([]);

  expect((await redeem(tryRequest("POST", { receipt }, "other"))).status).toBe(409);
  expect((await redeem(tryRequest("POST", { receipt: withDifferentSignedSummary(receipt) }))).status).toBe(409);
  const shifted = rewriteSignedReceipt(receipt, ({ issuedAt, expiresAt }) => ({
    issuedAt: issuedAt + 1, expiresAt: expiresAt + 1,
  }));
  const conflict = await redeem(tryRequest("POST", { receipt: shifted }));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "CONFLICT" } });
  expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
  const replays = await Promise.all([redeem(tryRequest("POST", { receipt })), redeem(tryRequest("POST", { receipt }))]);
  for (const replay of replays) {
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ edgeId, revisionId, replayed: true });
  }
  expect(await sql`SELECT DISTINCT edge_id FROM v3_bitemporal_misconception_edges WHERE workspace_id=${scope.workspaceId}`)
    .toEqual([{ edge_id: edgeId }]);
  expect(await sql`SELECT receipt_id, initial_revision_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`)
    .toEqual([{ receipt_id: verifyTryMisconceptionReceipt(receipt, secret).receiptId, initial_revision_id: revisionId }]);
});
