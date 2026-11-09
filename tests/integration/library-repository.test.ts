import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  LibraryError,
  type IdentityRepository,
  type LibraryRepository,
  type OpeningJobScope,
} from "@aistudy/database";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for library repository tests");
}

describe("library repository foundation", () => {
  const sql = createSqlClient(databaseUrl);
  let repo: LibraryRepository;
  let identity: IdentityRepository;
  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    await applyMigrations(sql);
    repo = createLibraryRepository(sql);
    identity = createIdentityRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      opening_workspace_history_revisions,
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;

    const userA = await identity.createUserWithWorkspace({
      email: `lib-a-${randomUUID()}@example.com`,
      displayName: "Lib A",
      passwordHash: "scrypt$not-used",
    });
    const userB = await identity.createUserWithWorkspace({
      email: `lib-b-${randomUUID()}@example.com`,
      displayName: "Lib B",
      passwordHash: "scrypt$not-used",
    });
    workspaceA = userA.workspace.id;
    workspaceB = userB.workspace.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("creates a document with ordered blocks and initial revision snapshot", async () => {
    const blockA = randomUUID();
    const blockB = randomUUID();

    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Linear algebra notes",
      lifecycle: "scratch",
      blocks: [
        {
          id: blockA,
          type: "heading",
          content: { level: 1, text: "Eigenvalues" },
        },
        {
          id: blockB,
          type: "paragraph",
          content: { text: "Definition and intuition." },
        },
      ],
    });

    expect(doc.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(doc.workspaceId).toBe(workspaceA);
    expect(doc.title).toBe("Linear algebra notes");
    expect(doc.lifecycle).toBe("scratch");
    expect(doc.schemaVersion).toBe(1);
    expect(doc.currentRevisionNumber).toBe(1);
    expect(doc.deletedAt).toBeNull();
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]).toMatchObject({
      id: blockA,
      type: "heading",
      position: 0,
      content: { level: 1, text: "Eigenvalues" },
    });
    expect(doc.blocks[1]).toMatchObject({
      id: blockB,
      type: "paragraph",
      position: 1,
    });

    const revisions = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revisionNumber).toBe(1);
    expect(revisions[0]?.title).toBe("Linear algebra notes");
    expect(revisions[0]?.blocks).toHaveLength(2);
    expect(revisions[0]?.blocks[0]?.id).toBe(blockA);
  });

  async function ownerScope(workspaceId = workspaceA) {
    const [workspace] = await sql`SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId}`;
    return { workspaceId, ownerUserId: workspace!.owner_user_id as string };
  }

  async function runningJob(): Promise<OpeningJobScope> {
    const scope = await ownerScope();
    const id = randomUUID();
    const token = randomUUID();
    await sql`INSERT INTO opening_jobs (id, workspace_id, owner_user_id, key, kind, payload, state, claim_token)
      VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${id}, 'parse', '{}', 'running', ${token})`;
    return { ...scope, jobExecution: { id, token, privacyEpoch: 0 } };
  }

  async function documentGraph(documentId: string) {
    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM library_documents WHERE id = ${documentId}) AS documents,
        (SELECT count(*)::int FROM library_blocks WHERE document_id = ${documentId}) AS blocks,
        (SELECT count(*)::int FROM library_revisions WHERE document_id = ${documentId}) AS revisions`;
    return counts;
  }

  async function historyRows() {
    return sql`SELECT workspace_id, owner_user_id, revision::int FROM opening_workspace_history_revisions
      ORDER BY workspace_id, owner_user_id`;
  }

  it.each(["generic", "legacy"] as const)("ensures history at zero without advancing it for %s creates", async (kind) => {
    const scope = await ownerScope();
    // A legacy scope without execution keeps its original no-op job gate,
    // even when its owner differs. History still uses the DB canonical owner.
    const jobScope = kind === "legacy" ? { ...scope, ownerUserId: (await ownerScope(workspaceB)).ownerUserId } : undefined;
    const input = { workspaceId: workspaceA, jobScope, title: "History fence", blocks: [
      { id: randomUUID(), type: "paragraph", content: { text: "draft" } },
    ] };
    expect(await historyRows()).toEqual([]);
    await repo.createDocument(input);
    expect(await historyRows()).toEqual([{ workspace_id: workspaceA, owner_user_id: scope.ownerUserId, revision: 0 }]);
    await sql`UPDATE opening_workspace_history_revisions SET revision = 17 WHERE workspace_id = ${workspaceA}`;
    await repo.createDocument({ ...input, blocks: [{ ...input.blocks[0]!, id: randomUUID() }] });
    expect(await historyRows()).toEqual([{ workspace_id: workspaceA, owner_user_id: scope.ownerUserId, revision: 17 }]);
  });

  it.each(["generic", "job"] as const)("waits on history before graph writes or workspace/job locks for %s creates", async (kind) => {
    const scope = await runningJob();
    await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
      VALUES (${workspaceA}, ${scope.ownerUserId}, 11)`;
    const holder = openRaceSession();
    const writer = openRaceSession();
    const observer = openRaceSession();
    const documentId = randomUUID();
    let pending: ReturnType<LibraryRepository["createDocument"]> | undefined;
    let started = 0;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async (tx) => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceA}
          AND owner_user_id = ${scope.ownerUserId} FOR UPDATE`;
        started = performance.now();
        pending = track(createLibraryRepository(writer.sql).createDocument({
          workspaceId: workspaceA, documentId, jobScope: kind === "job" ? scope : undefined,
          title: "Wait for history", blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "after release" } }],
        }));
        await waitUntilBlocked(observer.sql, writer.pid, holder.pid, "library create history", /opening_workspace_history_revisions[\s\S]*FOR UPDATE/);
        expect(await documentGraph(documentId)).toEqual({ documents: 0, blocks: 0, revisions: 0 });
        // A workspace lock taken before history would conflict here, as would
        // the execution gate's job lock. Neither may be held by the waiter.
        await tx`SELECT id FROM workspaces WHERE id = ${workspaceA} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM opening_jobs WHERE id = ${scope.jobExecution!.id} FOR UPDATE NOWAIT`;
      });
      console.info(`[library history barrier:${kind}] observed hold ${Math.round(performance.now() - started)}ms`);
      expect(await pending).toMatchObject({ id: documentId, currentRevisionNumber: 1 });
      expect(await documentGraph(documentId)).toEqual({ documents: 1, blocks: 1, revisions: 1 });
      expect(await historyRows()).toEqual([{ workspace_id: workspaceA, owner_user_id: scope.ownerUserId, revision: 11 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it.each(["owner", "token", "state", "epoch", "job workspace"] as const)("rolls back history and graph when the execution %s is stale", async (invalid) => {
    const scope = await runningJob();
    if (invalid === "owner") scope.ownerUserId = (await ownerScope(workspaceB)).ownerUserId;
    if (invalid === "token") scope.jobExecution!.token = randomUUID();
    if (invalid === "state") await sql`UPDATE opening_jobs SET state = 'cancelled' WHERE id = ${scope.jobExecution!.id}`;
    if (invalid === "epoch") await sql`UPDATE workspaces SET privacy_epoch = 1 WHERE id = ${workspaceA}`;
    if (invalid === "job workspace") await sql`UPDATE opening_jobs SET workspace_id = ${workspaceB} WHERE id = ${scope.jobExecution!.id}`;
    const documentId = randomUUID();
    const input = { workspaceId: workspaceA, documentId, jobScope: scope, title: "Stale create", blocks: [
      { id: randomUUID(), type: "paragraph", content: { text: "must roll back" } },
    ] };
    await expect(repo.createDocument(input)).rejects.toMatchObject({ code: "CONFLICT", message: "job execution is no longer current" });
    expect(await documentGraph(documentId)).toEqual({ documents: 0, blocks: 0, revisions: 0 });
    expect(await historyRows()).toEqual([]);
    const canonical = await ownerScope();
    await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
      VALUES (${workspaceA}, ${canonical.ownerUserId}, 23)`;
    await expect(repo.createDocument(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await documentGraph(documentId)).toEqual({ documents: 0, blocks: 0, revisions: 0 });
    expect(await historyRows()).toEqual([{ workspace_id: workspaceA, owner_user_id: canonical.ownerUserId, revision: 23 }]);
  });

  it.each(["delete before lookup", "delete after lookup", "change owner after lookup"] as const)("records the actual error for %s without graph/history writes", async (race) => {
    const mutator = openRaceSession();
    const documentId = randomUUID();
    const otherOwner = (await ownerScope(workspaceB)).ownerUserId;
    if (race === "change owner after lookup") {
      // The replacement owner must not already own another workspace.
      await sql`DELETE FROM workspaces WHERE id = ${workspaceB}`;
    }
    const mutate = async () => {
      if (race === "change owner after lookup") {
        await mutator.sql`UPDATE workspaces SET owner_user_id = ${otherOwner} WHERE id = ${workspaceA}`;
      } else {
        await mutator.sql`DELETE FROM workspaces WHERE id = ${workspaceA}`;
      }
    };
    // Keep every read/write on real PG; intercept only to place the independent
    // session's committed mutation exactly around the canonical-owner lookup.
    const coordinated = new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
          if (race === "delete before lookup") await mutate();
          return execute(new Proxy(tx, {
            apply(query, thisArg, args) {
              const result = Reflect.apply(query, thisArg, args) as Promise<unknown>;
              const [strings] = args as [TemplateStringsArray];
              return race !== "delete before lookup" && strings.join(" ").includes("SELECT owner_user_id FROM workspaces")
                ? result.then(async (rows) => { await mutate(); return rows; }) : result;
            },
          }));
        });
      },
    });
    try {
      await mutator.ready;
      const error = await createLibraryRepository(coordinated).createDocument({
        workspaceId: workspaceA, documentId, title: "Owner race", blocks: [
          { id: randomUUID(), type: "paragraph", content: { text: "must not persist" } },
        ],
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "NOT_FOUND", message: race === "delete before lookup"
        ? `Workspace not found: ${workspaceA}` : "workspace not found" });
      expect(error instanceof LibraryError).toBe(race === "delete before lookup");
      expect(await documentGraph(documentId)).toEqual({ documents: 0, blocks: 0, revisions: 0 });
      expect(await historyRows()).toEqual([]);
    } finally {
      await closeRace(mutator.sql);
    }
  });

  it("retains create validation precedence and does not ensure history for rejected inputs", async () => {
    const input = { workspaceId: workspaceA, title: "Valid", blocks: [
      { id: randomUUID(), type: "paragraph", content: { text: "valid" } },
    ] };
    const cases = [
      { input: { ...input, workspaceId: "invalid", title: "", blocks: [] }, code: "VALIDATION", message: "Invalid UUID for workspaceId" },
      { input: { ...input, workspaceId: randomUUID(), title: "", blocks: [] }, code: "NOT_FOUND", message: "Workspace not found:" },
      { input: { ...input, title: "", blocks: [] }, code: "VALIDATION", message: "Document title is required" },
      { input: { ...input, blocks: [] }, code: "VALIDATION", message: "at least one block" },
      { input: { ...input, documentId: "invalid" }, code: "VALIDATION", message: "Invalid UUID for documentId" },
      { input: { ...input, workspaceId: "invalid", title: "", blocks: [], jobScope: await ownerScope(workspaceB) },
        code: "CONFLICT", message: "job execution workspace differs from document workspace" },
    ];
    for (const testCase of cases) {
      const error = await repo.createDocument(testCase.input).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(LibraryError);
      expect(error).toMatchObject({ code: testCase.code, message: expect.stringContaining(testCase.message) });
    }
    expect(await historyRows()).toEqual([]);
  });

  it("retains the document ID unique conflict and rolls back a newly ensured history row", async () => {
    const documentId = randomUUID();
    const blockId = randomUUID();
    const input = { workspaceId: workspaceA, documentId, title: "Original", blocks: [
      { id: blockId, type: "paragraph", content: { text: "original" } },
    ] };
    const original = await repo.createDocument(input);
    // Model a pre-history legacy document without changing its graph.
    await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceA}`;
    await expect(repo.createDocument({ ...input, title: "Duplicate", blocks: [
      { id: randomUUID(), type: "paragraph", content: { text: "duplicate" } },
    ] })).rejects.toMatchObject({ code: "23505" });
    expect(await repo.getDocument({ workspaceId: workspaceA, documentId })).toEqual(original);
    expect(await documentGraph(documentId)).toEqual({ documents: 1, blocks: 1, revisions: 1 });
    expect(await historyRows()).toEqual([]);
  });

  type LifecycleOperation = "softDeleteDocument" | "restoreDocument";
  const lifecycleOperations: LifecycleOperation[] = ["softDeleteDocument", "restoreDocument"];

  async function lifecycleFixture(operation: LifecycleOperation, legacy = false) {
    const scope = await ownerScope();
    const document = await repo.createDocument({
      workspaceId: workspaceA, title: "Lifecycle history fence",
      jobScope: legacy ? { ...scope, ownerUserId: (await ownerScope(workspaceB)).ownerUserId } : undefined,
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "retain graph" } }],
    });
    if (operation === "restoreDocument") {
      await sql`UPDATE library_documents SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ${document.id}`;
    }
    return { workspaceId: workspaceA, documentId: document.id };
  }

  async function lifecycleSnapshot(documentId: string, client = sql) {
    const [document] = await client`SELECT * FROM library_documents WHERE id = ${documentId}`;
    const blocks = await client`SELECT * FROM library_blocks WHERE document_id = ${documentId} ORDER BY position`;
    const revisions = await client`SELECT * FROM library_revisions WHERE document_id = ${documentId} ORDER BY revision_number`;
    return { document, blocks, revisions };
  }

  it.each(lifecycleOperations)("%s waits on history before locking the document and retains the committed graph", async (operation) => {
    const input = await lifecycleFixture(operation);
    const original = await lifecycleSnapshot(input.documentId);
    const scope = await ownerScope();
    await sql`UPDATE opening_workspace_history_revisions SET revision = 29 WHERE workspace_id = ${workspaceA}`;
    const holder = openRaceSession();
    const writer = openRaceSession();
    const observer = openRaceSession();
    let pending: Promise<unknown> | undefined;
    try {
      await Promise.all([holder.ready, writer.ready, observer.ready]);
      await holder.sql.begin(async (tx) => {
        await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceA}
          AND owner_user_id = ${scope.ownerUserId} FOR UPDATE`;
        const started = performance.now();
        pending = track<unknown>(createLibraryRepository(writer.sql)[operation](input));
        await waitUntilBlocked(observer.sql, writer.pid, holder.pid, `library ${operation} history`,
          /opening_workspace_history_revisions[\s\S]*FOR UPDATE/);
        // Actual lock availability, not an elapsed-time approximation of ordering.
        await tx`SELECT id FROM library_documents WHERE id = ${input.documentId} FOR UPDATE NOWAIT`;
        await tx`SELECT id FROM workspaces WHERE id = ${workspaceA} FOR UPDATE NOWAIT`;
        expect(await lifecycleSnapshot(input.documentId, observer.sql)).toEqual(original);
        expect(await createLibraryRepository(observer.sql).getDocument({ ...input, includeDeleted: true }))
          .toMatchObject({ deletedAt: original.document!.deleted_at, currentRevisionNumber: 1 });
        console.info(`[library lifecycle barrier:${operation}] actual blocked observation ${Math.round(performance.now() - started)}ms`);
      });
      await pending;
      const after = await lifecycleSnapshot(input.documentId);
      expect(after.blocks).toEqual(original.blocks);
      expect(after.revisions).toEqual(original.revisions);
      expect(after.document).toEqual({ ...original.document,
        deleted_at: operation === "softDeleteDocument" ? expect.any(Date) : null,
        updated_at: expect.any(Date),
      });
      expect(await historyRows()).toEqual([{ workspace_id: workspaceA, owner_user_id: scope.ownerUserId, revision: 29 }]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(holder.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });

  it.each(lifecycleOperations)("%s lazily ensures legacy history at zero and never advances existing history", async (operation) => {
    const scope = await ownerScope();
    for (const legacy of [false, true]) {
      for (const revision of [null, 0, 37]) {
        const input = await lifecycleFixture(operation, legacy);
        await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceA}`;
        if (revision !== null) {
          await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
            VALUES (${workspaceA}, ${scope.ownerUserId}, ${revision})`;
        }
        const original = await lifecycleSnapshot(input.documentId);
        await repo[operation](input);
        expect(await historyRows()).toEqual([{ workspace_id: workspaceA, owner_user_id: scope.ownerUserId, revision: revision ?? 0 }]);
        const after = await lifecycleSnapshot(input.documentId);
        expect(after.blocks).toEqual(original.blocks);
        expect(after.revisions).toEqual(original.revisions);
        expect(after.document!.current_revision_number).toBe(original.document!.current_revision_number);
      }
    }
  });

  it.each(lifecycleOperations)("%s retains missing, cross-workspace and unchanged-state errors after commit", async (operation) => {
    const input = await lifecycleFixture(operation);
    const missingId = randomUUID();
    const missingWorkspace = randomUUID();
    await expect(repo[operation]({ workspaceId: workspaceA, documentId: missingId }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Document not found: ${missingId}` });
    await expect(repo[operation]({ workspaceId: missingWorkspace, documentId: missingId }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: `Document not found: ${missingId}` });
    for (const workspaceId of [workspaceB, missingWorkspace]) {
      await expect(repo[operation]({ ...input, workspaceId })).rejects.toMatchObject({
        code: "WORKSPACE_MISMATCH", message: `Document ${input.documentId} is not in workspace ${workspaceId}`,
      });
    }
    if (operation === "softDeleteDocument") await repo.softDeleteDocument(input);
    else await sql`UPDATE library_documents SET deleted_at = NULL WHERE id = ${input.documentId}`;
    const original = await lifecycleSnapshot(input.documentId);
    await expect(repo[operation](input)).rejects.toMatchObject({ code: "NOT_FOUND", message: operation === "softDeleteDocument"
      ? `Document already deleted or missing: ${input.documentId}` : `Document is not soft-deleted: ${input.documentId}` });
    expect(await lifecycleSnapshot(input.documentId)).toEqual(original);
  });

  it.each(lifecycleOperations)("%s rolls back an actual UPDATE and first history ensure when failure occurs before commit", async (operation) => {
    const input = await lifecycleFixture(operation);
    const scope = await ownerScope();
    const failure = new Error("injected after lifecycle UPDATE before commit");
    for (const revision of [null, 41]) {
      await sql`DELETE FROM opening_workspace_history_revisions WHERE workspace_id = ${workspaceA}`;
      if (revision !== null) {
        await sql`INSERT INTO opening_workspace_history_revisions (workspace_id, owner_user_id, revision)
          VALUES (${workspaceA}, ${scope.ownerUserId}, ${revision})`;
      }
      const original = await lifecycleSnapshot(input.documentId);
      const originalHistory = await historyRows();
      let injected = false;
      // Execute the real transaction callback and UPDATE. Fail only after its
      // returning row is available, while the transaction is still uncommitted.
      const failing = new Proxy(sql, {
        get(target, property, receiver) {
          if (property !== "begin") return Reflect.get(target, property, receiver);
          return (execute: (tx: TransactionSql) => Promise<unknown>) => target.begin(async (tx) => {
            const result = await execute(tx);
            expect(result).toEqual([{ id: input.documentId }]);
            const [changed] = await tx`SELECT deleted_at FROM library_documents WHERE id = ${input.documentId}`;
            expect(changed!.deleted_at).toEqual(operation === "softDeleteDocument" ? expect.any(Date) : null);
            const [history] = await tx`SELECT revision::int FROM opening_workspace_history_revisions
              WHERE workspace_id = ${workspaceA} AND owner_user_id = ${scope.ownerUserId}`;
            expect(history!.revision).toBe(revision ?? 0);
            expect(await lifecycleSnapshot(input.documentId)).toEqual(original);
            injected = true;
            throw failure;
          });
        },
      });
      await expect(createLibraryRepository(failing)[operation](input)).rejects.toBe(failure);
      expect(injected).toBe(true);
      expect(await lifecycleSnapshot(input.documentId)).toEqual(original);
      expect(await historyRows()).toEqual(originalHistory);
    }
  });

  it("lists active workspace documents newest first with their blocks", async () => {
    const older = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Older note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "older" } }],
    });
    const newer = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Newer note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "newer" } }],
    });
    const deleted = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Deleted note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "deleted" } }],
    });
    await repo.createDocument({
      workspaceId: workspaceB,
      title: "Other workspace note",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "other" } }],
    });
    await repo.softDeleteDocument({ workspaceId: workspaceA, documentId: deleted.id });
    await sql`
      UPDATE library_documents
      SET updated_at = CASE
        WHEN id = ${older.id} THEN '2026-01-01T00:00:00Z'::timestamptz
        WHEN id = ${newer.id} THEN '2026-01-02T00:00:00Z'::timestamptz
        ELSE updated_at
      END
      WHERE workspace_id = ${workspaceA}
    `;

    const documents = await repo.listDocuments({ workspaceId: workspaceA });

    expect(documents.map((document) => document.title)).toEqual([
      "Newer note",
      "Older note",
    ]);
    expect(documents[0]?.blocks[0]?.content).toEqual({ text: "newer" });
    expect(documents.every((document) => document.workspaceId === workspaceA)).toBe(true);
  });

  it("keeps block IDs stable across edits and appends a new revision", async () => {
    const blockA = randomUUID();
    const blockB = randomUUID();

    const created = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Draft",
      blocks: [
        { id: blockA, type: "paragraph", content: { text: "v1" } },
        { id: blockB, type: "paragraph", content: { text: "keep me" } },
      ],
    });

    const updated = await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: created.id,
      expectedRevisionNumber: 1,
      title: "Draft v2",
      blocks: [
        { id: blockA, type: "paragraph", content: { text: "v2 edited" } },
        { id: blockB, type: "paragraph", content: { text: "keep me" } },
        {
          id: randomUUID(),
          type: "code",
          content: { language: "ts", text: "const x = 1;" },
        },
      ],
      reason: "user-edit",
    });

    expect(updated.currentRevisionNumber).toBe(2);
    expect(updated.title).toBe("Draft v2");
    expect(updated.blocks).toHaveLength(3);
    expect(updated.blocks[0]?.id).toBe(blockA);
    expect(updated.blocks[0]?.content).toEqual({ text: "v2 edited" });
    expect(updated.blocks[1]?.id).toBe(blockB);

    const revisions = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: created.id,
    });
    expect(revisions.map((r) => r.revisionNumber)).toEqual([1, 2]);

    // Revision 1 remains recoverable and unchanged (append-only).
    const rev1 = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: created.id,
      revisionNumber: 1,
    });
    expect(rev1.title).toBe("Draft");
    expect(rev1.blocks).toHaveLength(2);
    expect(rev1.blocks[0]?.content).toEqual({ text: "v1" });
    expect(rev1.reason).toBe("create");

    const rev2 = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: created.id,
      revisionNumber: 2,
    });
    expect(rev2.title).toBe("Draft v2");
    expect(rev2.blocks).toHaveLength(3);
    expect(rev2.parentRevisionNumber).toBe(1);
    expect(rev2.reason).toBe("user-edit");
  });

  it("rejects stale document writes without mutating the projection or history", async () => {
    const blockId = randomUUID();
    const created = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Concurrency",
      blocks: [{ id: blockId, type: "paragraph", content: { text: "v1" } }],
    });

    const firstSave = {
      workspaceId: workspaceA,
      documentId: created.id,
      expectedRevisionNumber: 1,
      title: "Concurrency v2",
      blocks: [{ id: blockId, type: "paragraph", content: { text: "v2" } }],
      reason: "first-save",
    };
    await repo.updateDocument(firstSave);

    await expect(
      repo.updateDocument({
        ...firstSave,
        title: "Stale overwrite",
        blocks: [{ id: blockId, type: "paragraph", content: { text: "stale" } }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const current = await repo.getDocument({ workspaceId: workspaceA, documentId: created.id });
    expect(current).toMatchObject({
      title: "Concurrency v2",
      currentRevisionNumber: 2,
      blocks: [{ id: blockId, content: { text: "v2" } }],
    });
    expect(current.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    const revisions = await repo.listRevisions({ workspaceId: workspaceA, documentId: created.id });
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
  });

  it("does not mutate historical revision rows when editing", async () => {
    const blockId = randomUUID();
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Immutable history",
      blocks: [{ id: blockId, type: "paragraph", content: { text: "first" } }],
    });

    const before = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: doc.id,
      revisionNumber: 1,
    });

    await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
      expectedRevisionNumber: 1,
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "second" } },
      ],
    });

    const after = await repo.getRevision({
      workspaceId: workspaceA,
      documentId: doc.id,
      revisionNumber: 1,
    });

    expect(after).toEqual(before);
    expect(after.blocks[0]?.content).toEqual({ text: "first" });
  });

  it("enforces lifecycle transitions without changing an invalid document", async () => {
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Lifecycle document",
      lifecycle: "candidate",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "v1" } }],
    });

    const confirmed = await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
      expectedRevisionNumber: 1,
      lifecycle: "confirmed",
      blocks: doc.blocks,
      reason: "confirm",
    });
    const published = await repo.updateDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
      expectedRevisionNumber: 2,
      lifecycle: "published",
      blocks: confirmed.blocks,
      reason: "publish",
    });
    const revisionsBeforeInvalidTransition = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });

    await expect(
      repo.updateDocument({
        workspaceId: workspaceA,
        documentId: doc.id,
        expectedRevisionNumber: 3,
        lifecycle: "candidate",
        blocks: published.blocks,
        reason: "invalid-demotion",
      }),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_TRANSITION" });

    const current = await repo.getDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    const revisionsAfterInvalidTransition = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(current.lifecycle).toBe("published");
    expect(current.updatedAt).toEqual(published.updatedAt);
    expect(current.blocks).toEqual(published.blocks);
    expect(revisionsAfterInvalidTransition).toEqual(revisionsBeforeInvalidTransition);
  });

  it("creates typed relations between documents and blocks", async () => {
    const srcBlock = randomUUID();
    const dstBlock = randomUUID();

    const source = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Source note",
      blocks: [
        { id: srcBlock, type: "paragraph", content: { text: "claim" } },
      ],
    });
    const target = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Target note",
      blocks: [
        { id: dstBlock, type: "paragraph", content: { text: "evidence" } },
      ],
    });

    const docLink = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: target.id,
      relationType: "references",
    });

    const blockLink = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "block",
      fromId: srcBlock,
      toType: "block",
      toId: dstBlock,
      relationType: "supports",
    });

    const embed = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "block",
      toId: dstBlock,
      relationType: "embeds",
    });

    expect(docLink.relationType).toBe("references");
    expect(blockLink.fromId).toBe(srcBlock);
    expect(embed.toType).toBe("block");

    const listed = await repo.listRelations({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: source.id,
    });
    expect(listed).toHaveLength(2);
    expect(listed.map((r) => r.relationType).sort()).toEqual([
      "embeds",
      "references",
    ]);

    const repeated = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: target.id,
      relationType: "references",
    });
    expect(repeated.id).toBe(docLink.id);
    expect((await repo.listRelations({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: source.id,
    })).filter((relation) => relation.relationType === "references")).toHaveLength(1);
  });

  it("synchronizes wiki-link relations without deleting manual relations and reports only inserts", async () => {
    const source = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Wiki source",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "source" } }],
    });
    const firstTarget = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Wiki first target",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "target" } }],
    });
    const secondTarget = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Wiki second target",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "target" } }],
    });
    await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: firstTarget.id,
      relationType: "references",
    });

    await expect(repo.syncWikiLinkRelations({
      workspaceId: workspaceA,
      documentId: source.id,
      targetDocumentIds: [firstTarget.id, secondTarget.id, secondTarget.id],
    })).resolves.toEqual({ indexed: 1 });

    const firstSync = await repo.listRelations({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: source.id,
    });
    expect(firstSync).toEqual(expect.arrayContaining([
      expect.objectContaining({ toId: firstTarget.id, source: "manual" }),
      expect.objectContaining({ toId: secondTarget.id, source: "wiki-link" }),
    ]));

    await expect(repo.syncWikiLinkRelations({
      workspaceId: workspaceA,
      documentId: source.id,
      targetDocumentIds: [firstTarget.id],
    })).resolves.toEqual({ indexed: 0 });

    const secondSync = await repo.listRelations({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: source.id,
    });
    expect(secondSync).toEqual(expect.arrayContaining([
      expect.objectContaining({ toId: firstTarget.id, source: "manual" }),
    ]));
    expect(secondSync).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ toId: secondTarget.id }),
    ]));
  });

  it("updates and deletes relations without crossing workspace or merging type collisions", async () => {
    const source = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Relation source",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "source" } }],
    });
    const target = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Relation target",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "target" } }],
    });
    const first = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: target.id,
      relationType: "references",
    });
    const second = await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: target.id,
      relationType: "supports",
    });

    await expect(repo.updateRelationType({
      workspaceId: workspaceA,
      relationId: first.id,
      relationType: "related",
    })).resolves.toMatchObject({
      id: first.id,
      fromId: source.id,
      toId: target.id,
      relationType: "related",
      createdAt: first.createdAt,
    });
    await expect(repo.updateRelationType({
      workspaceId: workspaceA,
      relationId: first.id,
      relationType: "supports",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.getRelation({ workspaceId: workspaceA, relationId: second.id })).resolves.toMatchObject({ relationType: "supports" });

    await repo.deleteRelation({ workspaceId: workspaceA, relationId: first.id });
    await expect(repo.getRelation({ workspaceId: workspaceA, relationId: first.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.getRelation({ workspaceId: workspaceB, relationId: second.id })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
    await expect(repo.deleteRelation({ workspaceId: workspaceB, relationId: second.id })).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });
  });

  it("rejects relations whose endpoints belong to a soft-deleted document", async () => {
    const source = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Live source",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "source" } }],
    });
    const targetBlock = randomUUID();
    const target = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Deleted target",
      blocks: [{ id: targetBlock, type: "paragraph", content: { text: "target" } }],
    });
    await repo.softDeleteDocument({ workspaceId: workspaceA, documentId: target.id });

    await expect(repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "document",
      toId: target.id,
      relationType: "references",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.createRelation({
      workspaceId: workspaceA,
      fromType: "document",
      fromId: source.id,
      toType: "block",
      toId: targetBlock,
      relationType: "references",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps block relations addressable after the source document is soft-deleted", async () => {
    const sourceBlock = randomUUID();
    const targetBlock = randomUUID();
    const source = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Deleted source",
      blocks: [{ id: sourceBlock, type: "paragraph", content: { text: "source" } }],
    });
    await repo.createDocument({
      workspaceId: workspaceA,
      title: "Target",
      blocks: [{ id: targetBlock, type: "paragraph", content: { text: "target" } }],
    });
    await repo.createRelation({
      workspaceId: workspaceA,
      fromType: "block",
      fromId: sourceBlock,
      toType: "block",
      toId: targetBlock,
      relationType: "supports",
    });
    await repo.softDeleteDocument({ workspaceId: workspaceA, documentId: source.id });

    await expect(repo.getBlock({
      workspaceId: workspaceA,
      blockId: sourceBlock,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.getBlock({
      workspaceId: workspaceA,
      blockId: sourceBlock,
      includeDeleted: true,
    })).resolves.toMatchObject({ document: { id: source.id, deletedAt: expect.any(Date) } });
  });

  it("attaches typed properties to documents and blocks", async () => {
    const blockId = randomUUID();
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "Properties",
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "body" } },
      ],
    });

    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "status",
      valueType: "string",
      value: "active",
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "priority",
      valueType: "number",
      value: 3,
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "block",
      subjectId: blockId,
      key: "flagged",
      valueType: "boolean",
      value: true,
    });
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "meta",
      valueType: "json",
      value: { tags: ["math", "core"], score: 0.9 },
    });

    // Upsert same key updates value without duplicating.
    await repo.setProperty({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
      key: "priority",
      valueType: "number",
      value: 5,
    });

    const props = await repo.listProperties({
      workspaceId: workspaceA,
      subjectType: "document",
      subjectId: doc.id,
    });

    expect(props).toHaveLength(3);
    const byKey = Object.fromEntries(props.map((p) => [p.key, p]));
    expect(byKey.status).toMatchObject({
      valueType: "string",
      value: "active",
    });
    expect(byKey.priority).toMatchObject({ valueType: "number", value: 5 });
    expect(byKey.meta?.value).toEqual({ tags: ["math", "core"], score: 0.9 });

    const blockProps = await repo.listProperties({
      workspaceId: workspaceA,
      subjectType: "block",
      subjectId: blockId,
    });
    expect(blockProps).toHaveLength(1);
    expect(blockProps[0]).toMatchObject({
      key: "flagged",
      valueType: "boolean",
      value: true,
    });
  });

  it("soft-deletes and restores a document without destroying revisions", async () => {
    const blockId = randomUUID();
    const doc = await repo.createDocument({
      workspaceId: workspaceA,
      title: "To archive",
      blocks: [
        { id: blockId, type: "paragraph", content: { text: "payload" } },
      ],
    });

    await repo.softDeleteDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });

    await expect(
      repo.getDocument({ workspaceId: workspaceA, documentId: doc.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      repo.getDocument({
        workspaceId: workspaceA,
        documentId: doc.id,
        includeDeleted: true,
      }),
    ).resolves.toMatchObject({
      id: doc.id,
      deletedAt: expect.any(Date),
    });

    const revisionsWhileDeleted = await repo.listRevisions({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(revisionsWhileDeleted).toHaveLength(1);

    const restored = await repo.restoreDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(restored.deletedAt).toBeNull();
    expect(restored.blocks[0]?.id).toBe(blockId);

    const again = await repo.getDocument({
      workspaceId: workspaceA,
      documentId: doc.id,
    });
    expect(again.title).toBe("To archive");
  });

  it("rejects cross-workspace document access and relations", async () => {
    const blockInA = randomUUID();
    const blockInB = randomUUID();

    const docA = await repo.createDocument({
      workspaceId: workspaceA,
      title: "A only",
      blocks: [
        { id: blockInA, type: "paragraph", content: { text: "private A" } },
      ],
    });
    const docB = await repo.createDocument({
      workspaceId: workspaceB,
      title: "B only",
      blocks: [
        { id: blockInB, type: "paragraph", content: { text: "private B" } },
      ],
    });

    await expect(
      repo.getDocument({ workspaceId: workspaceB, documentId: docA.id }),
    ).rejects.toBeInstanceOf(LibraryError);

    await expect(
      repo.updateDocument({
        workspaceId: workspaceB,
        documentId: docA.id,
        expectedRevisionNumber: 1,
        title: "hijack",
        blocks: [
          { id: blockInA, type: "paragraph", content: { text: "nope" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });

    await expect(
      repo.createRelation({
        workspaceId: workspaceA,
        fromType: "document",
        fromId: docA.id,
        toType: "document",
        toId: docB.id,
        relationType: "references",
      }),
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });

    await expect(
      repo.createRelation({
        workspaceId: workspaceA,
        fromType: "block",
        fromId: blockInA,
        toType: "block",
        toId: blockInB,
        relationType: "supports",
      }),
    ).rejects.toMatchObject({ code: "CROSS_WORKSPACE_REFERENCE" });

    await expect(
      repo.setProperty({
        workspaceId: workspaceA,
        subjectType: "document",
        subjectId: docB.id,
        key: "x",
        valueType: "string",
        value: "y",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" });

    // Original content in A remains intact.
    const stillA = await repo.getDocument({
      workspaceId: workspaceA,
      documentId: docA.id,
    });
    expect(stillA.title).toBe("A only");
    expect(stillA.blocks[0]?.content).toEqual({ text: "private A" });
  });

  it("rejects empty block lists and unknown lifecycle values", async () => {
    await expect(
      repo.createDocument({
        workspaceId: workspaceA,
        title: "Empty",
        blocks: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await expect(
      repo.createDocument({
        workspaceId: workspaceA,
        title: "Bad lifecycle",
        // @ts-expect-error intentional invalid lifecycle for runtime guard
        lifecycle: "formal",
        blocks: [
          {
            id: randomUUID(),
            type: "paragraph",
            content: { text: "x" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("applies migrations idempotently (round-trip)", async () => {
    // Second apply must be a no-op success.
    const first = await applyMigrations(sql);
    const second = await applyMigrations(sql);
    expect(first.applied.length + first.alreadyApplied.length).toBeGreaterThan(
      0,
    );
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain("0001_library.sql");
  });
});
