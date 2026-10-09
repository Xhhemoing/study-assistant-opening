import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  channelFromConnectionKind,
  createOpeningImportChunksRepository,
  listAuthorizedImportChunks,
} from "./opening-import-chunks";
import { OpeningKnowledgeError } from "./opening-knowledge";

const W = "00000000-0000-4000-8000-0000000000w1";
const U = "00000000-0000-4000-8000-0000000000u1";
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const SOURCE = "00000000-0000-4000-8000-0000000000s1";
const RECEIPT = "00000000-0000-4000-8000-0000000000r1";
const RECEIPT2 = "00000000-0000-4000-8000-0000000000r2";
const scope = { workspaceId: W, ownerUserId: U };

function makeSql(opts: {
  courseFound?: boolean;
  rows?: Array<Record<string, unknown>>;
  onQuery?: (q: string, values: unknown[]) => void;
}): Sql {
  const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    if (!Object.hasOwn(parts, "raw")) {
      // Helper used as sql(array) for IN lists — return identity-ish for mock.
      return parts as unknown;
    }
    const q = parts.join("?").replace(/\s+/g, " ").trim();
    opts.onQuery?.(q, values);
    if (q.startsWith("SELECT c.id FROM courses")) {
      return Promise.resolve(opts.courseFound === false ? [] : [{ id: COURSE }]);
    }
    if (q.includes("FROM opening_import_receipts")) {
      return Promise.resolve(opts.rows ?? []);
    }
    throw new Error("unexpected SQL: " + q);
  }) as unknown as Sql;
  // Support nested sql`` fragments and sql(array) inside the template.
  Object.assign(sql, {
    begin: async (cb: (tx: Sql) => Promise<unknown>) => cb(sql),
  });
  return sql;
}

describe("channelFromConnectionKind", () => {
  it("maps imap → mail and keeps dingtalk", () => {
    expect(channelFromConnectionKind("imap")).toBe("mail");
    expect(channelFromConnectionKind("dingtalk")).toBe("dingtalk");
    expect(channelFromConnectionKind("other")).toBe("other");
  });
});

describe("listAuthorizedImportChunks", () => {
  it("returns [] when course has no authorized imports", async () => {
    const sql = makeSql({ rows: [] });
    await expect(listAuthorizedImportChunks(sql, scope, COURSE)).resolves.toEqual([]);
  });

  it("throws NOT_FOUND when course is not owned by scope", async () => {
    const sql = makeSql({ courseFound: false });
    await expect(listAuthorizedImportChunks(sql, scope, COURSE)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listAuthorizedImportChunks(sql, scope, COURSE)).rejects.toBeInstanceOf(
      OpeningKnowledgeError,
    );
  });

  it("joins chunk pages per receipt and never uses created_at as sentAt", async () => {
    const created = new Date("2026-10-01T12:00:00.000Z");
    const sql = makeSql({
      rows: [
        {
          receipt_id: RECEIPT,
          source_id: SOURCE,
          connection_kind: "imap",
          text: "  线性代数作业截止 2026-10-22  ",
          page: 1,
          chunk_created_at: created,
        },
        {
          receipt_id: RECEIPT,
          source_id: SOURCE,
          connection_kind: "imap",
          text: "请在课程平台提交",
          page: 2,
          chunk_created_at: created,
        },
      ],
    });
    const chunks = await listAuthorizedImportChunks(sql, scope, COURSE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      sourceId: SOURCE,
      receiptId: RECEIPT,
      text: "线性代数作业截止 2026-10-22\n请在课程平台提交",
      sentAt: null,
      channel: "mail",
    });
    expect(chunks[0]!.sentAt).not.toBe(created.toISOString());
  });

  it("maps dingtalk kind to channel dingtalk", async () => {
    const sql = makeSql({
      rows: [
        {
          receipt_id: RECEIPT,
          source_id: SOURCE,
          connection_kind: "dingtalk",
          text: "考试通知 2026-11-01",
          page: null,
          chunk_created_at: null,
        },
      ],
    });
    const [chunk] = await listAuthorizedImportChunks(sql, scope, COURSE);
    expect(chunk?.channel).toBe("dingtalk");
    expect(chunk?.sentAt).toBeNull();
    expect(chunk).not.toHaveProperty("isForward");
  });

  it("applies receiptIds filter in SQL and returns [] for empty filter", async () => {
    const seen: string[] = [];
    const sql = makeSql({
      rows: [
        {
          receipt_id: RECEIPT,
          source_id: SOURCE,
          connection_kind: "imap",
          text: "作业",
          page: 1,
          chunk_created_at: null,
        },
      ],
      onQuery: (q) => seen.push(q),
    });
    await expect(listAuthorizedImportChunks(sql, scope, COURSE, [])).resolves.toEqual([]);
    expect(seen.some((q) => q.includes("opening_import_receipts"))).toBe(false);

    await listAuthorizedImportChunks(sql, scope, COURSE, [RECEIPT, RECEIPT2]);
    const listQuery = seen.find((q) => q.includes("opening_import_receipts"));
    expect(listQuery).toMatch(/AND r.id IN/);
    expect(listQuery).toMatch(/conn.state <> 'revoked'/);
    expect(listQuery).toMatch(/asset_type = 'source'/);
    expect(listQuery).toMatch(/parse_state = 'ready'/);
    expect(listQuery).toMatch(/upload_state = 'uploaded'/);
    expect(listQuery).toMatch(/c.text ~ /);
  });

  it("SQL gate excludes revoked / requires course membership (asserted via query shape)", async () => {
    let listQuery = "";
    const sql = makeSql({
      rows: [],
      onQuery: (q) => {
        if (q.includes("opening_import_receipts")) listQuery = q;
      },
    });
    await createOpeningImportChunksRepository(sql).listAuthorizedImportChunks(scope, COURSE);
    expect(listQuery).toContain("course_asset_memberships");
    expect(listQuery).toContain("conn.state <> 'revoked'");
    expect(listQuery).toContain("r.owner_user_id");
    expect(listQuery).toContain("r.workspace_id");
  });
});
