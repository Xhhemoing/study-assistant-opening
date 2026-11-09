import type { Sql, TransactionSql } from "postgres";
import { beforeEach, expect, it, vi } from "vitest";
import { createOpeningConversationRepository, OpeningConversationError } from "./opening-conversations";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";

vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn() }));
const scope = { workspaceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", ownerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const canonicalOwner = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const input = { title: " unchanged title ", courseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
beforeEach(() => { vi.mocked(lockWorkspaceLearningHistory).mockReset(); });

function database(options: { absent?: boolean; lockedOwner?: string | null; insertError?: Error } = {}) {
  const writes: unknown[][] = [];
  const committed: unknown[][] = [];
  const tx = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("INSERT INTO opening_conversations")) {
      if (options.insertError) throw options.insertError;
      writes.push(values);
      return [];
    }
    if (query.includes("FOR SHARE")) return options.lockedOwner === null ? [] : [{ owner_user_id: options.lockedOwner ?? canonicalOwner }];
    return options.absent ? [] : [{ owner_user_id: canonicalOwner }];
  });
  const begin = vi.fn(async (work: (sql: TransactionSql) => Promise<unknown>) => {
    try {
      const result = await work(tx as unknown as TransactionSql);
      committed.push(...writes);
      return result;
    } catch (error) { writes.length = 0; throw error; }
  });
  const root = vi.fn(() => { throw new Error("create must not use root SQL outside its transaction"); });
  const sql = Object.assign(root, { begin }) as unknown as Sql;
  return { sql, root, tx, begin, committed };
}

it("coordinates on canonical owner in the same transaction but inserts/returns caller values unchanged", async () => {
  const db = database();
  const result = await createOpeningConversationRepository(db.sql).create(scope, input);
  expect(db.begin).toHaveBeenCalledOnce(); expect(db.root).not.toHaveBeenCalled();
  expect(lockWorkspaceLearningHistory).toHaveBeenCalledExactlyOnceWith(db.tx, { ...scope, ownerUserId: canonicalOwner });
  expect(result).toEqual({ id: expect.any(String), ...input });
  expect(db.committed).toEqual([[result.id, scope.workspaceId, scope.ownerUserId, input.title, input.courseId]]);
});

it("lets a static missing workspace reach INSERT and propagates the actual PG error by identity", async () => {
  const error = Object.assign(new Error("foreign key violation"), { code: "23503" });
  const db = database({ absent: true, insertError: error });
  await expect(createOpeningConversationRepository(db.sql).create(scope, input)).rejects.toBe(error);
  expect(lockWorkspaceLearningHistory).not.toHaveBeenCalled(); expect(db.committed).toEqual([]);
});

it("maps only the helper's exact missing-workspace error to typed coordination conflict", async () => {
  const db = database();
  vi.mocked(lockWorkspaceLearningHistory).mockRejectedValueOnce(Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" }));
  const creation = createOpeningConversationRepository(db.sql).create(scope, input);
  await expect(creation).rejects.toBeInstanceOf(OpeningConversationError);
  await expect(creation).rejects.toMatchObject({ code: "CONFLICT", message: "Conversation history coordination changed" });
  expect(db.committed).toEqual([]); expect(db.tx).toHaveBeenCalledTimes(1);
  expect(lockWorkspaceLearningHistory).toHaveBeenCalledOnce();
});

it.each([
  Object.assign(new Error("another not found"), { code: "NOT_FOUND" }),
  Object.assign(new Error("workspace not found"), { code: "22P02" }),
  Object.assign(new Error("serialization failure"), { code: "40001" }),
  new Error("history unavailable"),
])("does not swallow or retry unrelated history failure: %s", async error => {
  const db = database(); vi.mocked(lockWorkspaceLearningHistory).mockRejectedValueOnce(error);
  await expect(createOpeningConversationRepository(db.sql).create(scope, input)).rejects.toBe(error);
  expect(db.committed).toEqual([]); expect(db.begin).toHaveBeenCalledOnce();
  expect(lockWorkspaceLearningHistory).toHaveBeenCalledOnce();
});

it.each([null, scope.ownerUserId])("rolls back when the post-history locked workspace is missing or has drifted (%s)", async lockedOwner => {
  const db = database({ lockedOwner });
  await expect(createOpeningConversationRepository(db.sql).create(scope, input)).rejects.toMatchObject({
    code: "CONFLICT", message: "Conversation history coordination changed",
  });
  expect(db.committed).toEqual([]); expect(lockWorkspaceLearningHistory).toHaveBeenCalledOnce();
});

it.each(["22P02", "23514"])("preserves INSERT errors after history by identity (%s)", async code => {
  const error = Object.assign(new Error("original INSERT failure"), { code });
  const db = database({ insertError: error });
  await expect(createOpeningConversationRepository(db.sql).create(scope, input)).rejects.toBe(error);
  expect(db.committed).toEqual([]); expect(lockWorkspaceLearningHistory).toHaveBeenCalledOnce();
});
