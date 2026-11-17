import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listMigrationFiles } from "../../packages/database/src/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { projectMaterialFeedback } from "../../packages/domain/src/opening/material-attempt-presentation";
import type { JSONValue, Sql } from "postgres";
import { databaseRows, deferred, feedbackReader, seedFeedback } from "./opening-material-feedback-snapshot-independent.fixture";
import type { OpeningMaterialFeedbackBinding } from "../../packages/database/src/repositories/opening-material-feedback-snapshot";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });

describe("card1: real PG submitted teaching-item/current publication binding (DI host only)", () => {
  it("uses all real migrations with verified checksums and preserves revision immutability", async () => {
    const files = await listMigrationFiles();
    const expected = files.map(id => ({
      id,
      checksum: createHash("sha256").update(readFileSync(
        new URL(`../../packages/database/src/migrations/${id}`, import.meta.url), "utf8",
      )).digest("hex"),
      verification_state: "verified",
    }));
    const migrations = await f.sql`SELECT id,checksum,verification_state FROM schema_migrations ORDER BY id`;
    expect(migrations).toHaveLength(files.length);
    expect(migrations[0]!.id).toMatch(/^0001_/);
    expect(migrations[files.length - 1]!.id).toBe(files[files.length - 1]);
    expect([...migrations]).toEqual(expected);
    const guards = await f.sql`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='library_revisions'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(guards).toEqual(expect.arrayContaining([
      expect.objectContaining({ tgname: "library_revisions_no_update", tgenabled: "O" }),
      expect.objectContaining({ tgname: "library_revisions_no_delete", tgenabled: "O" }),
    ]));
  });

  it.each(["两列各在不同坐标方向，线性无关，矩阵的秩为二。", "按列向量定义：两个标准基向量均独立，所以秩等于二。"])(
    "executes the real joins/JSON pairing and returns the actual distinct stored answer: %s", async answer => {
      const h = await seedFeedback(f, answer);
      const [saved] = await f.sql`SELECT a.submitted_at,a.observation_id,a.problem_id,a.item_version_id,v.evaluation_spec,v.stem_snapshot
        FROM opening_learning_attempts a JOIN opening_learning_item_versions v ON v.id=a.item_version_id WHERE a.id=${h.b.attemptId}`;
      expect(saved!.submitted_at).not.toBeNull();
      expect(saved!.observation_id).not.toBeNull();
      expect(saved!.evaluation_spec).toMatchObject({ kind: "teaching_question", blockId: h.b.blockId, answerBlockId: h.b.answerBlockId,
        revisionId: h.b.revisionId, sourceRefs: h.b.sourceRefs });
      const snapshot = await h.repo.resolveFeedback(h.access);
      expect(snapshot).toEqual(h.expected);
      const projected = projectMaterialFeedback({ id: h.b.blockId, sourceFile: h.b.sourceFile, physicalPage: h.b.physicalPage,
        answer: { role: "answer_key", text: "CLIENT KEY" }, postAttemptNotes: "CLIENT NOTES" }, h.access, { resolveFeedback: () => snapshot });
      expect(projected).toMatchObject({ status: "available", feedback: h.expected, independentEligibility: "unknown" });
      expect(JSON.stringify(projected)).not.toMatch(/DECOY|PRIVATE|CLIENT|rubric/);
      const wrongKey = { ...h.b, answerBlockId: h.decoyAnswer };
      expect(await feedbackReader(f.sql, wrongKey).resolveFeedback(h.access)).toBeNull();
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    });
});

type Seed = Awaited<ReturnType<typeof seedFeedback>>;
type Mutation = (sql: Sql, h: Seed) => Promise<unknown>;
const mutations: Array<[string, Mutation]> = [
  ["session workspace", (sql, h) => sql`UPDATE opening_learning_sessions SET workspace_id=${f.otherScope.workspaceId} WHERE id=${h.session.id}`],
  ["session owner", (sql, h) => sql`UPDATE opening_learning_sessions SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${h.session.id}`],
  ["item owner", (sql, h) => sql`UPDATE opening_learning_item_versions SET owner_user_id=${f.otherScope.ownerUserId} WHERE id=${h.b.itemVersionId}`],
  ["item problem", (sql, h) => sql`UPDATE opening_learning_item_versions SET problem_id=${h.decoyAnswer} WHERE id=${h.b.itemVersionId}`],
  ["course archived", (sql, h) => sql`UPDATE courses SET archived_at=now() WHERE id=${h.b.courseId}`],
  ["document withdrawn", (sql, h) => sql`UPDATE library_documents SET deleted_at=now() WHERE id=${h.b.documentId}`],
  ["unit rejected", (sql, h) => sql`UPDATE opening_teaching_units SET verification_status='rejected' WHERE id=${h.b.teachingUnitId}`],
  ["spec stale", (sql, h) => sql`UPDATE opening_teaching_activity_specs SET verification_status='stale' WHERE activity_id=${h.b.activityId}`],
  ["activity not ready", (sql, h) => sql`UPDATE opening_teaching_activities SET generate_status='needs_check' WHERE id=${h.b.activityId}`],
  ["activity version", (sql, h) => sql`UPDATE opening_teaching_activities SET content_version=2 WHERE id=${h.b.activityId}`],
  ["source membership absent", (sql, h) => sql`DELETE FROM course_asset_memberships WHERE course_id=${h.b.courseId} AND asset_id=${h.b.sourceId}`],
  ["source membership archived", (sql, h) => sql`UPDATE course_asset_memberships SET role='archive' WHERE course_id=${h.b.courseId} AND asset_id=${h.b.sourceId}`],
  ["privacy exclusion", (sql, h) => sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at) VALUES (${h.b.workspaceId},${h.b.sourceId},now())`],
  ["source version", (sql, h) => sql`UPDATE opening_sources SET version=2 WHERE id=${h.b.sourceId}`],
  ["source SHA", (sql, h) => sql`UPDATE opening_sources SET sha256=${"b".repeat(64)} WHERE id=${h.b.sourceId}`],
  ["source not uploaded", (sql, h) => sql`UPDATE opening_sources SET upload_state='pending' WHERE id=${h.b.sourceId}`],
  ["source parse not ready", (sql, h) => sql`UPDATE opening_sources SET parse_state='failed' WHERE id=${h.b.sourceId}`],
  ["exact source chunk absent", (sql, h) => sql`DELETE FROM opening_source_chunks WHERE id=${h.chunkId}`],
  ["wrong physical page", (sql, h) => sql`UPDATE opening_source_chunks SET page=2 WHERE id=${h.chunkId}`],
  ["attempt provenance version", (sql, h) => sql`UPDATE opening_learning_attempts SET source_versions=${sql.json({ [h.b.sourceId]: 2 })} WHERE id=${h.b.attemptId}`],
  ["session provenance absent", (sql, h) => sql`UPDATE opening_learning_sessions SET source_ids='{}'::uuid[] WHERE id=${h.session.id}`],
  ["activity provenance absent", (sql, h) => sql`UPDATE opening_teaching_activities SET source_ids='{}'::uuid[] WHERE id=${h.b.activityId}`],
  ["same-version block order JSON replacement", (sql, h) => sql`UPDATE opening_teaching_activity_specs SET block_order='[]'::jsonb WHERE activity_id=${h.b.activityId}`],
  ["same-version source refs JSON replacement", (sql, h) => sql`UPDATE opening_teaching_activity_specs SET source_refs='[]'::jsonb WHERE activity_id=${h.b.activityId}`],
  ["saved item stem replacement", (sql, h) => sql`UPDATE opening_learning_item_versions SET stem_snapshot='FOREIGN STEM' WHERE id=${h.b.itemVersionId}`],
  ["saved item answer binding replacement", (sql, h) => sql`UPDATE opening_learning_item_versions SET evaluation_spec=jsonb_set(evaluation_spec,'{answerBlockId}',to_jsonb(${h.decoyAnswer}::text)) WHERE id=${h.b.itemVersionId}`],
  ["saved item source refs replacement", (sql, h) => sql`UPDATE opening_learning_item_versions SET evaluation_spec=jsonb_set(evaluation_spec,'{sourceRefs}','[]'::jsonb) WHERE id=${h.b.itemVersionId}`],
];

describe("card2: real PG denial predicates and no-write early-help boundary", () => {
  it.each(["workspaceId", "ownerUserId", "courseId", "itemVersionId", "problemId", "activityId", "revisionId"] as const)(
    "denies a foreign host %s, without confusing DI with authentication", async key => {
      const h = await seedFeedback(f);
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
      const b: OpeningMaterialFeedbackBinding = { ...h.b, [key]: f.otherScope.workspaceId };
      expect(await feedbackReader(f.sql, b).resolveFeedback(h.access)).toBeNull();
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    });

  it.each(mutations)("denies real stored %s, with matching before/after negative controls", async (_label, mutate) => {
    const h = await seedFeedback(f);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    const rollback = new Error("test-only rollback after assertions");
    await expect(f.sql.begin(async tx => {
      const sql = tx as unknown as Sql; // Real postgres.js transaction, not an SQL fake.
      await mutate(sql, h);
      const snapshot = await feedbackReader(sql, h.b).resolveFeedback(h.access);
      expect(snapshot).toBeNull();
      expect(projectMaterialFeedback({ id: h.b.blockId, sourceFile: h.b.sourceFile, physicalPage: h.b.physicalPage,
        answer: { role: "answer_key", text: "CLIENT KEY" }, authorized: true }, h.access,
      { resolveFeedback: () => snapshot }).status).toBe("unavailable");
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
  });

  it("denies stale host revision JSON, while DB append-only rejects an actual same-ID revision replacement", async () => {
    const h = await seedFeedback(f);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    const blocks = structuredClone(h.b.revisionBlocks) as Array<{ id: string; content: { text: string } }>;
    blocks.find(block => block.id === h.b.answerBlockId)!.content.text = "FOREIGN SAME-ID KEY";
    expect(await feedbackReader(f.sql, { ...h.b, revisionBlocks: blocks as JSONValue }).resolveFeedback(h.access)).toBeNull();
    await expect(f.sql`UPDATE library_revisions SET blocks=${f.sql.json(blocks)} WHERE id=${h.b.revisionId}`)
      .rejects.toMatchObject({ code: "23000", message: "library_revisions is append-only" });
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
  });

  it("unsubmitted item and explicit help deny without any durable public-table write", async () => {
    const h = await seedFeedback(f, undefined, false);
    const [attempt] = await f.sql`SELECT submitted_at FROM opening_learning_attempts WHERE id=${h.b.attemptId}`;
    expect(attempt!.submitted_at).toBeNull();
    const before = await databaseRows(f.sql);
    expect(await h.repo.resolveFeedback(h.access)).toBeNull();
    let calls = 0;
    const early = feedbackReader(f.sql, h.b, async () => { calls++; throw new Error("early-help must not invoke host"); });
    const request = { ...h.access, mode: "explicit_help" as const };
    const snapshot = await early.resolveFeedback(request);
    expect(snapshot).toBeNull();
    expect(calls).toBe(0);
    expect(projectMaterialFeedback({ id: h.b.blockId, sourceFile: h.b.sourceFile, physicalPage: h.b.physicalPage,
      answer: { role: "answer_key", text: "CLIENT KEY" }, exposureRecorded: true }, request,
    { resolveFeedback: () => snapshot }).status).toBe("unavailable");
    expect(await databaseRows(f.sql)).toEqual(before);
  });
});


describe("card3: real PG concurrent windows, read-only and snapshot limits", () => {
  it("runs the real success SELECT inside a READ ONLY transaction with identical whole-DB data", async () => {
    const h = await seedFeedback(f), before = await databaseRows(f.sql);
    await f.sql.begin("read only", async tx => {
      expect((await tx`SHOW transaction_read_only`)[0]!.transaction_read_only).toBe("on");
      expect(await feedbackReader(tx as unknown as Sql, h.b).resolveFeedback(h.access)).toEqual(h.expected);
    });
    expect(await databaseRows(f.sql)).toEqual(before);
  });

  it.each(["membership", "privacy", "withdrawal"] as const)(
    "a committed %s change while the DI host is paused is denied by the later SQL snapshot", async change => {
      const h = await seedFeedback(f);
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
      const entered = deferred<void>(), release = deferred<void>();
      const repo = feedbackReader(f.sql, h.b, async () => {
        const captured = structuredClone(h.b);
        entered.resolve();
        await release.promise;
        return captured;
      });
      const reading = repo.resolveFeedback(h.access);
      try {
        await entered.promise;
        if (change === "membership") await f.sql`UPDATE course_asset_memberships SET role='archive'
          WHERE course_id=${h.b.courseId} AND asset_id=${h.b.sourceId}`;
        if (change === "privacy") await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at)
          VALUES (${h.b.workspaceId},${h.b.sourceId},now())`;
        if (change === "withdrawal") await f.sql`UPDATE library_documents SET deleted_at=now() WHERE id=${h.b.documentId}`;
      } finally { release.resolve(); }
      expect(await reading).toBeNull();
      expect(await h.repo.resolveFeedback(h.access)).toBeNull();
    });

  it("only sees committed state at each SELECT: an uncommitted removal is not a global revocation guarantee", async () => {
    const h = await seedFeedback(f);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    const changed = deferred<void>(), commit = deferred<void>();
    const writer = f.sql.begin(async tx => {
      await tx`DELETE FROM course_asset_memberships WHERE course_id=${h.b.courseId} AND asset_id=${h.b.sourceId}`;
      changed.resolve();
      await commit.promise;
    });
    try {
      await changed.promise;
      // Separate real DB connection must not see another transaction's uncommitted deletion.
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    } finally { commit.resolve(); }
    await writer;
    expect(await h.repo.resolveFeedback(h.access)).toBeNull();
  });

  it("a repeatable-read caller retains its older snapshot; a fresh read denies after committed revocation", async () => {
    const h = await seedFeedback(f);
    await f.sql.begin("isolation level repeatable read read only", async tx => {
      const repo = feedbackReader(tx as unknown as Sql, h.b);
      expect(await repo.resolveFeedback(h.access)).toEqual(h.expected);
      await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${h.b.courseId} AND asset_id=${h.b.sourceId}`;
      expect(await repo.resolveFeedback(h.access)).toEqual(h.expected);
      expect(await h.repo.resolveFeedback(h.access)).toBeNull();
    });
  });

  it("an already returned detached snapshot does not revoke itself and must not be reused as authority", async () => {
    const h = await seedFeedback(f), snapshot = await h.repo.resolveFeedback(h.access);
    expect(snapshot).toEqual(h.expected);
    await f.sql`UPDATE library_documents SET deleted_at=now() WHERE id=${h.b.documentId}`;
    expect(await h.repo.resolveFeedback(h.access)).toBeNull();
    // This documents a limit, NOT permission to use the old snapshot for a new request.
    expect(snapshot).toEqual(h.expected);
  });

  it("a legal appended current document revision invalidates the old attempt's feedback binding", async () => {
    const h = await seedFeedback(f);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    const document = await h.appendRevision();
    expect(document.currentRevisionNumber).toBe(2);
    expect(await h.repo.resolveFeedback(h.access)).toBeNull();
    expect((await f.sql`SELECT blocks FROM library_revisions WHERE id=${h.b.revisionId}`)[0]!.blocks).toEqual(h.b.revisionBlocks);
  });

  it.each(["role", "position"] as const)(
    "rejects invalid ordered pairing %s even when host JSON equals current DB JSON", async change => {
      const h = await seedFeedback(f);
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
      const b = structuredClone(h.b);
      const order = b.blockOrder as Array<{ blockId: string; role: string; position: number }>;
      const key = order.find(ref => ref.blockId === b.answerBlockId)!;
      if (change === "role") key.role = "teach";
      else key.position += 2;
      const rollback = new Error("rollback pairing probe");
      await expect(f.sql.begin(async tx => {
        await tx`UPDATE opening_teaching_activity_specs SET block_order=${tx.json(b.blockOrder)} WHERE activity_id=${b.activityId}`;
        expect(await feedbackReader(tx as unknown as Sql, b).resolveFeedback(h.access)).toBeNull();
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    });

  it("rejects wrong source-page JSON even when host/spec/item payloads agree", async () => {
    const h = await seedFeedback(f), b = structuredClone(h.b);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    (b.sourceRefs as Array<{ page: number }>)[0]!.page = 2;
    const rollback = new Error("rollback source page probe");
    await expect(f.sql.begin(async tx => {
      await tx`UPDATE opening_teaching_activity_specs SET source_refs=${tx.json(b.sourceRefs)} WHERE activity_id=${b.activityId}`;
      await tx`UPDATE opening_learning_item_versions SET evaluation_spec=jsonb_set(evaluation_spec,'{sourceRefs}',${tx.json(b.sourceRefs)}) WHERE id=${b.itemVersionId}`;
      expect(await feedbackReader(tx as unknown as Sql, b).resolveFeedback(h.access)).toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
  });

  it("propagates an actual PostgreSQL UUID cast error instead of converting it to unavailable or success", async () => {
    const h = await seedFeedback(f);
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
    await expect(feedbackReader(f.sql, { ...h.b, workspaceId: "not-a-uuid" }).resolveFeedback(h.access))
      .rejects.toMatchObject({ code: "22P02" });
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
  });

  it("JSONB equality is semantic, not serialized key-order equality", async () => {
    const h = await seedFeedback(f), b = structuredClone(h.b);
    b.sourceRefs = (b.sourceRefs as Array<Record<string, JSONValue>>).map(ref => Object.fromEntries(Object.entries(ref).reverse()));
    expect(await feedbackReader(f.sql, b).resolveFeedback(h.access)).toEqual(h.expected);
  });

  // Explicit private acceptance replay; default integration CI has no course-package file.
  it.skipIf(!process.env.MATERIAL_COURSE_REAL_FULL_INPUT)("all 150 actual 041fc627 generic questions stay unavailable without imported bindings; no number/page guessing", async () => {
    const path = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
    expect(path, "explicit private replay requires an input path").toBeTruthy();
    const bytes = readFileSync(path!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    const input = JSON.parse(bytes.toString()) as { questions: Array<{ id: string; sourceFile: string; physicalPage: number }> };
    expect(input.questions).toHaveLength(150);
    const h = await seedFeedback(f), before = await databaseRows(f.sql);
    let hostCalls = 0;
    const unbound = feedbackReader(f.sql, null, async () => { hostCalls++; return null; });
    for (const question of input.questions) {
      const access = { ...h.access, questionId: question.id, source: { file: question.sourceFile, page: question.physicalPage } };
      const snapshot = await unbound.resolveFeedback(access);
      expect(snapshot).toBeNull();
      expect(projectMaterialFeedback(question, access, { resolveFeedback: () => snapshot }).status).toBe("unavailable");
    }
    expect(hostCalls).toBe(150);
    expect(await databaseRows(f.sql)).toEqual(before);
    // Even a genuine teaching binding does not bind a guessed generic ID at the same source/page.
    expect(await h.repo.resolveFeedback({ ...h.access, questionId: "Q9" })).toBeNull();
    expect(await h.repo.resolveFeedback(h.access)).toEqual(h.expected);
  });
});
