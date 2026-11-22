import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyLearnerMisconceptionCorrection,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  executeOpeningRestoreApply,
  readOpeningBackupRecords,
  readOpeningRestoreNamespaceCounts,
  queryMisconceptionEdgesAsOf,
  type OpeningScope,
} from "@aistudy/database";
import { composeOpeningBackupDraft, type OpeningBackup } from "@aistudy/domain";
import { POST as redeem, PUT as issue } from "../../apps/web/src/app/api/opening/public-try/misconception-handoff/route";
import { POST as correct } from "../../apps/web/src/app/api/opening/memory/bitemporal-correction/route";
import { issueTryMisconceptionReceipt } from "../../apps/web/src/features/opening/public-try/v3-try-misconception-handoff";
import { createAuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

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

async function seedEdge({
  scope = f.scope, edgeId = randomUUID(), courseId = null, evidenceAttemptIds = [], future = false,
}: { scope?: OpeningScope; edgeId?: string; courseId?: string | null; evidenceAttemptIds?: string[]; future?: boolean } = {}) {
  const [row] = await f.sql<{ edgeId: string; revisionId: string; txAt: string }[]>`
    INSERT INTO v3_bitemporal_misconception_edges
      (revision_id, workspace_id, owner_user_id, edge_id, course_id, concept_key, misconception_code, summary, status, origin,
       evidence_attempt_ids, valid_range, tx_range)
    VALUES (${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${edgeId}, ${courseId},
      'limit', 'conditions', 'Initial diagnosis', 'verified', 'system_diagnosis', ${evidenceAttemptIds}::uuid[],
      tstzrange('2000-01-01Z'::timestamptz, NULL, '[)'),
      tstzrange(clock_timestamp() + CASE WHEN ${future} THEN interval '5 seconds' ELSE interval '0' END, NULL, '[)'))
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
  let correction: ReturnType<typeof applyLearnerMisconceptionCorrection> | undefined;
  try {
    const releasedAt = await sql.begin(async tx => {
      await tx`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE revision_id=${released.revisionId} FOR UPDATE`;
      const [holder] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      correction = track(applyLearnerMisconceptionCorrection(writer.sql, scope,
        { edgeId: released.edgeId, disposition: "clarified", summary: "After the row lock" }));
      await waitUntilBlocked(sql, writer.pid, holder!.pid, "correction waits for edge lock",
        /FROM v3_bitemporal_misconception_edges[\s\S]+FOR UPDATE/);
      const [clock] = await tx<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
      return clock!.at;
    });
    const result = await correction!;
    const [time] = await sql`SELECT ${result.txAt}::text::timestamptz >= ${releasedAt}::text::timestamptz AS after_lock`;
    expect(time!.after_lock).toBe(true);
  } finally {
    await correction?.catch(() => undefined);
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

  const payload = JSON.parse(Buffer.from(receipt.split(".")[0], "base64url").toString("utf8"));
  const changed = Buffer.from(JSON.stringify({ ...payload, summary: "Different signed payload" })).toString("base64url");
  const signature = createHmac("sha256", secret).update("opening:try-misconception:v1." + changed).digest("base64url");
  expect((await redeem(tryRequest("POST", { receipt: changed + "." + signature }))).status).toBe(409);
  const expired = issueTryMisconceptionReceipt(selection, secret, Date.now() - 900_001);
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

  const contested = issueTryMisconceptionReceipt(selection, secret);
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
  const first = await seedEdge({ courseId });
  await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId: first.edgeId, disposition: "clarified", summary: "Course correction" });
  const receiptId = randomUUID();
  const insertReceipt = (ownerId: string) => sql`INSERT INTO v3_try_misconception_handoff_receipts
    (receipt_id, workspace_id, owner_user_id, payload_sha256, edge_id, initial_revision_id, redeemed_at)
    VALUES (${receiptId}, ${scope.workspaceId}, ${ownerId}, ${"a".repeat(64)}, ${first.edgeId}, ${first.revisionId}, clock_timestamp())`;
  await expect(insertReceipt(otherScope.ownerUserId)).rejects.toMatchObject({
    code: "23503", constraint_name: "v3_try_receipt_workspace_owner",
  });
  await insertReceipt(scope.ownerUserId);
  await expect(sql`DELETE FROM v3_bitemporal_misconception_edges WHERE edge_id=${first.edgeId}`)
    .rejects.toMatchObject({ code: "23514" });
  expect(await sql`SELECT revision_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${first.edgeId}`).toHaveLength(2);
  await sql`DELETE FROM courses WHERE id=${courseId}`;
  expect(await sql`SELECT edge_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${first.edgeId}`).toEqual([]);
  expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE receipt_id=${receiptId}`).toEqual([]);

  const independent = await seedEdge();
  await sql`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
  expect(await sql`SELECT edge_id FROM v3_bitemporal_misconception_edges WHERE edge_id=${independent.edgeId}`).toEqual([]);
  expect(await sql`SELECT revision FROM v3_learner_context_blocks WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
});

it("rejects a stale expected privacy epoch even when it matches the stored revision", async () => {
  const { sql, scope } = f;
  const first = await seedEdge();
  const query = { validAt, txAt: first.txAt, expectedPrivacyEpoch: 0 };
  await expect(queryMisconceptionEdgesAsOf(sql, scope, query)).resolves.toMatchObject([{ revisionId: first.revisionId }]);
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  await expect(queryMisconceptionEdgesAsOf(sql, scope, query)).resolves.toEqual([]);
  await expect(queryMisconceptionEdgesAsOf(sql, scope, { ...query, expectedPrivacyEpoch: 1 })).resolves.toEqual([]);
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

it("round-trips misconception corrections through a v1 workspace backup and rebuilds derived context", async () => {
  const { sql, scope } = f;
  const receipt = issueTryMisconceptionReceipt(selection, secret);
  const redeemed = await redeem(tryRequest("POST", { receipt }));
  expect(redeemed.status).toBe(201);
  const { edgeId, revisionId } = await redeemed.json();
  const firstCorrection = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId, disposition: "disputed", summary: "I worked through the limit again" });
  const secondCorrection = await applyLearnerMisconceptionCorrection(sql, scope,
    { edgeId, disposition: "clarified", summary: "I can explain the condition now" });
  const records = await readOpeningBackupRecords(sql, scope);
  const composed = composeOpeningBackupDraft({ records, staging: {
    snapshot: { workspaceId: scope.workspaceId, privacyEpoch: records.privacyEpoch,
      deletionJournal: records.deletionJournal, memoryDeletions: records.memoryDeletions, sources: [] },
    objects: [],
  } });
  if (!composed.ok) throw new Error(composed.errors.join(", "));
  const archive: OpeningBackup = JSON.parse(JSON.stringify(composed.backup));
  const rows = archive.tables.v3_bitemporal_misconception_edges as Record<string, unknown>[];
  expect(rows.map(row => row.revision_id)).toEqual([revisionId, firstCorrection.revisionId, secondCorrection.revisionId]);
  expect(archive.tables).not.toHaveProperty("v3_try_misconception_handoff_receipts");
  expect(archive.tables).not.toHaveProperty("v3_learner_context_blocks");
  const exported = [...rows];
  rows.reverse();

  // Opening restore preserves IDs in a clean copy of the original workspace.
  await sql`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
  // The history counter predates this migration and is independent of workspace cascades.
  await sql`DELETE FROM opening_workspace_history_revisions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  await sql`INSERT INTO workspaces(id, owner_user_id) VALUES (${scope.workspaceId}, ${scope.ownerUserId})`;
  const counts = await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId);
  expect(counts.v3_bitemporal_misconception_edges).toBe(0);
  const restore = () => executeOpeningRestoreApply(sql, { confirmLocalRestore: true, backup: archive,
    currentMemoryDeletions: archive.memoryDeletions, currentLearningState: { workspacePreferences: null, courses: [] },
  });
  await sql`UPDATE workspaces SET privacy_epoch=1 WHERE id=${scope.workspaceId}`;
  await expect(restore()).resolves.toMatchObject({ ok: false, code: "PREFLIGHT_REJECTED", mutated: false });
  expect(await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId)).toEqual(counts);
  await sql`UPDATE workspaces SET privacy_epoch=0 WHERE id=${scope.workspaceId}`;
  const restored = await restore();
  expect(restored, restored.errors.join(", ")).toMatchObject({ ok: true });
  const roundTrip = await readOpeningBackupRecords(sql, scope);
  expect(roundTrip.tables.v3_bitemporal_misconception_edges).toEqual(exported);
  expect((await readOpeningRestoreNamespaceCounts(sql, scope.workspaceId)).v3_bitemporal_misconception_edges).toBe(3);
  const [block] = await sql`SELECT rendered_markdown, byte_length, revision FROM v3_learner_context_blocks
    WHERE workspace_id=${scope.workspaceId}`;
  expect(block).toMatchObject({ rendered_markdown: "- 学习者补充说明：I can explain the condition now", revision: 1 });
  expect(block!.byte_length).toBe(Buffer.byteLength(block!.rendered_markdown));
  expect(await sql`SELECT receipt_id FROM v3_try_misconception_handoff_receipts WHERE workspace_id=${scope.workspaceId}`).toEqual([]);
});
