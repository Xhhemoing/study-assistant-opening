import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import {
  PENDING_UPLOAD_TTL_FALLBACK_MS,
  PENDING_UPLOAD_TTL_SWEEP_LIMIT,
  UPLOAD_TTL_EXPIRED_ERROR,
  createOpeningSourceRepository,
  OpeningSourceError,
  sweepExpiredPendingUploads,
  sweepExpiredPendingUploadsAll,
} from "./opening-sources";

const W = "00000000-0000-4000-8000-000000000001";
const S = "00000000-0000-4000-8000-000000000003";
const SHA = "a".repeat(64);
const scope = { workspaceId: W, ownerUserId: "00000000-0000-4000-8000-0000000000aa" };

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: S,
    workspace_id: W,
    name: "a.pdf",
    mime: "application/pdf",
    bytes: 12,
    sha256: SHA,
    version: 0,
    upload_state: "pending",
    parse_state: "not_started",
    error: null,
    created_at: new Date("2026-09-13T00:00:00.000Z"),
    updated_at: new Date("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

function transactionalSql(handler: (query: string) => unknown[]) {
  let revision = 0;
  const sql = ((parts: TemplateStringsArray | unknown[]) => {
    if (!Object.hasOwn(parts, "raw")) return parts;
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: W }]);
    if (query.startsWith("WITH quota_objects AS")) return Promise.resolve([{ bytes: "0", objects: "0" }]);
    if (query.startsWith("INSERT INTO opening_workspace_history_revisions")) return Promise.resolve([]);
    if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return Promise.resolve([{ revision }]);
    if (query.startsWith("UPDATE opening_workspace_history_revisions")) return Promise.resolve([{ revision: ++revision }]);
    if (query.startsWith("DELETE FROM opening_learning_eligibility") || query.startsWith("p.") || query === "FALSE"
      || query.startsWith("baseline.source_ids &&") || query.startsWith("r.learning_protocol->>'baselineRootId'=")) return Promise.resolve([]);
    return Promise.resolve(handler(query));
  }) as unknown as Sql;
  sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
  return { sql, revision: () => revision };
}
describe("opening source upload completion boundary", () => {
  it("rejects complete when stored object mismatches ticket", async () => {
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("SELECT * FROM opening_sources")) return [pendingRow()];
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    await expect(
      repo.complete(scope, S, { bytes: 11, sha256: SHA, mime: "application/pdf" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(revision()).toBe(0);
  });

  it("pending → uploaded on exact match; replay is idempotent", async () => {
    let state = "pending";
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("SELECT * FROM opening_sources")) {
        return [pendingRow({ upload_state: state })];
      }
      if (q.startsWith("WITH completed AS (")) {
        state = "uploaded";
        return [pendingRow({ upload_state: "uploaded" })];
      }
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    const first = await repo.complete(scope, S, {
      bytes: 12,
      sha256: SHA,
      mime: "application/pdf",
    });
    expect(first.uploadState).toBe("uploaded");
    expect(first).not.toHaveProperty("courseId");
    const second = await repo.complete(scope, S, {
      bytes: 12,
      sha256: SHA,
      mime: "application/pdf",
    });
    expect(second.uploadState).toBe("uploaded");
    expect(revision()).toBe(1);
  });

  it("create returns SourceRecord without courseId", async () => {
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("INSERT INTO opening_sources")) return [pendingRow()];
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    const record = await repo.create(scope, {
      name: "a.pdf",
      mime: "application/pdf",
      bytes: 12,
      sha256: SHA,
    });
    expect(record.uploadState).toBe("pending");
    expect(Object.keys(record)).not.toContain("courseId");
    expect(revision()).toBe(0);
  });

  it("rejects a completion job when the workspace epoch changed before the transaction lock", async () => {
    const { sql, revision } = transactionalSql((q) => {
      if (q.startsWith("SELECT id, privacy_epoch FROM workspaces")) return [{ id: W, privacy_epoch: 8 }];
      if (q.startsWith("SELECT * FROM opening_sources")) return [pendingRow()];
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    await expect(repo.completeWithParseJob(scope, S, {
      key: "parse:source:v0",
      payload: { sourceId: S },
      privacyEpoch: 7,
      actual: { bytes: 12, sha256: SHA, mime: "application/pdf" },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(revision()).toBe(0);
  });
});

describe("upload ticket history coordination boundary", () => {
  const ticket = { uploadUrl: "/staging/ticket", expiresAt: "2030-01-01T00:00:00.000Z" };
  function ticketSql(handle?: (query: string, values: unknown[]) => unknown[] | undefined) {
    const queries: { query: string; values: unknown[] }[] = [];
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      queries.push({ query, values });
      const rows = handle?.(query, values);
      if (rows !== undefined) return Promise.resolve(rows);
      if (query.startsWith("SELECT * FROM opening_sources")) return Promise.resolve([pendingRow()]);
      if (query.startsWith("SELECT owner_user_id FROM workspaces")) return Promise.resolve([{ owner_user_id: scope.ownerUserId }]);
      if (query.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: W }]);
      if (query.startsWith("INSERT INTO opening_workspace_history_revisions") || query.startsWith("UPDATE opening_sources")) return Promise.resolve([]);
      if (query.startsWith("SELECT revision FROM opening_workspace_history_revisions")) return Promise.resolve([{ revision: 17 }]);
      throw new Error("unexpected: " + query);
    }) as unknown as Sql;
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
    return { sql, queries };
  }

  it.each(["missing", "nonpending"])("preserves static %s error before history and signer", async state => {
    const { sql, queries } = ticketSql(q => q.startsWith("SELECT * FROM opening_sources")
      ? state === "missing" ? [] : [pendingRow({ upload_state: "uploaded" })] : undefined);
    const sign = vi.fn(async () => ticket);
    const work = createOpeningSourceRepository(sql).issueUploadTicket(scope, S, sign);
    await expect(work).rejects.toBeInstanceOf(OpeningSourceError);
    await expect(work).rejects.toMatchObject(state === "missing"
      ? { code: "NOT_FOUND", message: "Source not found" }
      : { code: "CONFLICT", message: "Upload is no longer pending" });
    expect(queries).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled();
  });

  it("uses canonical owner only for history and signs the locked, not preflight, source", async () => {
    const { sql, queries } = ticketSql(q => q.startsWith("SELECT * FROM opening_sources") && q.includes("FOR UPDATE")
      ? [pendingRow({ name: "locked.pdf", bytes: 22 })] : undefined);
    const sign = vi.fn(async () => ticket);
    const result = await createOpeningSourceRepository(sql).issueUploadTicket({ ...scope, ownerUserId: "not-a-uuid" }, S, sign);
    expect(result).toMatchObject({ source: { name: "locked.pdf", bytes: 22 }, ...ticket });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0]).toEqual([result.source]);
    expect(queries.find(q => q.query.startsWith("INSERT INTO opening_workspace_history_revisions"))!.values)
      .toEqual([W, scope.ownerUserId]);
    expect(queries.flatMap(q => q.values)).not.toContain("not-a-uuid");
    expect(queries.filter(q => q.query.includes("opening_sources") && q.query.startsWith("SELECT")))
      .toHaveLength(2);
    expect(queries.filter(q => q.query.startsWith("UPDATE opening_workspace_history_revisions"))).toEqual([]);
  });

  it.each(["helper", "workspace-lock", "source-lock", "lease"])("propagates driver errors at %s unchanged", async boundary => {
    const failure = Object.assign(new Error("database failure"), { code: "55P03" });
    const { sql } = ticketSql(q => {
      if ((boundary === "helper" && q.startsWith("INSERT INTO opening_workspace_history_revisions"))
        || (boundary === "workspace-lock" && q.includes("FOR SHARE"))
        || (boundary === "source-lock" && q.includes("opening_sources") && q.includes("FOR UPDATE"))
        || (boundary === "lease" && q.startsWith("UPDATE opening_sources"))) throw failure;
      return undefined;
    });
    const sign = vi.fn(async () => ticket);
    await expect(createOpeningSourceRepository(sql).issueUploadTicket(scope, S, sign)).rejects.toBe(failure);
    expect(sign).toHaveBeenCalledTimes(boundary === "lease" ? 1 : 0);
  });

  it.each([
    { code: "NOT_FOUND", message: "other helper failure" },
    { code: "XX000", message: "workspace not found" },
  ])("does not translate a non-exact helper failure: %j", async details => {
    const failure = Object.assign(new Error(details.message), { code: details.code });
    const { sql } = ticketSql(q => {
      if (q.startsWith("INSERT INTO opening_workspace_history_revisions")) throw failure;
      return undefined;
    });
    const sign = vi.fn(async () => ticket);
    await expect(createOpeningSourceRepository(sql).issueUploadTicket(scope, S, sign)).rejects.toBe(failure);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("G4 pending upload TTL sweeper", () => {
  const NOW = new Date("2026-10-10T12:00:00.000Z");
  const S2 = "00000000-0000-4000-8000-000000000004";
  const W2 = "00000000-0000-4000-8000-000000000002";

  function sweepSql(handler: (query: string, values: unknown[]) => unknown[]) {
    const recorded: { query: string; values: unknown[] }[] = [];
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      if (!Object.hasOwn(parts, "raw")) return parts;
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      recorded.push({ query, values });
      return Promise.resolve(handler(query, values));
    }) as unknown as Sql;
    sql.json = ((value: unknown) => value) as Sql["json"];
    sql.begin = (async (callback: (tx: Sql) => Promise<unknown>) => callback(sql)) as Sql["begin"];
    return { sql, recorded };
  }

  it("rejects expired pending via upload_url_expires_at and returns swept ids", async () => {
    const { sql, recorded } = sweepSql((q) => {
      if (q.startsWith("UPDATE opening_sources AS s")) {
        return [{ id: S, workspace_id: W }];
      }
      throw new Error("unexpected: " + q);
    });
    const swept = await sweepExpiredPendingUploads(sql, scope, { now: NOW });
    expect(swept).toEqual([{ id: S, workspaceId: W }]);
    const update = recorded[0]!;
    expect(update.query).toMatch(/upload_state = 'rejected'/);
    expect(update.query).toMatch(/upload_url_expires_at < \?/);
    expect(update.query).toMatch(/upload_url_expires_at IS NULL/);
    expect(update.query).toMatch(/created_at < \?/);
    expect(update.query).toMatch(/upload_state = 'pending'/);
    expect(update.values).toContainEqual(UPLOAD_TTL_EXPIRED_ERROR);
    expect(update.values).toContainEqual(NOW);
    expect(update.values).toContainEqual(
      new Date(NOW.getTime() - PENDING_UPLOAD_TTL_FALLBACK_MS),
    );
    expect(update.values).toContainEqual(W);
    expect(update.values).toContainEqual(PENDING_UPLOAD_TTL_SWEEP_LIMIT);
  });

  it("null-lease fallback uses created_at + PENDING_UPLOAD_TTL_FALLBACK_MS (15m lease)", () => {
    expect(PENDING_UPLOAD_TTL_FALLBACK_MS).toBe(900_000);
    expect(UPLOAD_TTL_EXPIRED_ERROR).toEqual({
      code: "UPLOAD_TTL_EXPIRED",
      message: "上传凭证已过期，文件未在有效期内完成上传。",
      retryable: false,
    });
  });

  it("global All passes null workspace scope and respects limit", async () => {
    const { sql, recorded } = sweepSql((q) => {
      if (q.startsWith("UPDATE opening_sources AS s")) {
        return [
          { id: S, workspace_id: W },
          { id: S2, workspace_id: W2 },
        ];
      }
      throw new Error("unexpected: " + q);
    });
    const swept = await sweepExpiredPendingUploadsAll(sql, { now: NOW, limit: 25 });
    expect(swept).toEqual([
      { id: S, workspaceId: W },
      { id: S2, workspaceId: W2 },
    ]);
    const values = recorded[0]!.values;
    expect(values).toContainEqual(null);
    expect(values).toContainEqual(25);
    expect(recorded[0]!.query).toMatch(/\?::uuid IS NULL OR workspace_id = \?/);
  });

  it("idempotent: already-rejected / non-pending yield empty (SQL filters pending only)", async () => {
    const { sql, recorded } = sweepSql((q) => {
      if (q.startsWith("UPDATE opening_sources AS s")) return [];
      throw new Error("unexpected: " + q);
    });
    await expect(sweepExpiredPendingUploads(sql, scope, { now: NOW })).resolves.toEqual([]);
    expect(recorded[0]!.query).toMatch(/WHERE upload_state = 'pending'/);
    expect(recorded[0]!.query).toMatch(/AND s\.upload_state = 'pending'/);
  });

  it("repository method delegates to workspace-scoped sweep", async () => {
    const { sql } = sweepSql((q) => {
      if (q.startsWith("UPDATE opening_sources AS s")) {
        return [{ id: S, workspace_id: W }];
      }
      throw new Error("unexpected: " + q);
    });
    const repo = createOpeningSourceRepository(sql);
    await expect(repo.sweepExpiredPendingUploads(scope, { now: NOW })).resolves.toEqual([
      { id: S, workspaceId: W },
    ]);
  });

  it("does not invent Slack/email — return list is the optional notify hook", async () => {
    const { sql } = sweepSql(() => [{ id: S, workspace_id: W }]);
    const swept = await sweepExpiredPendingUploadsAll(sql, { now: NOW, limit: 1 });
    // Callers (Pipeline worker) may iterate swept ids for notify; Data only returns them.
    expect(swept.map((row) => row.id)).toEqual([S]);
  });
});
