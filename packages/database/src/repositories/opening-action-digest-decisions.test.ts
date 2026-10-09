import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { ActionCandidate } from "@aistudy/contracts";
import {
  createOpeningActionDigestDecisionsRepository,
} from "./opening-action-digest-decisions";
import { OpeningPlanError } from "./opening-plan-error";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const scope = { workspaceId, ownerUserId };

function candidate(overrides: Partial<ActionCandidate> = {}): ActionCandidate {
  return {
    id: overrides.id ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    dedupeKey: overrides.dedupeKey ?? "hw:math:ch3",
    title: overrides.title ?? "Finish math homework",
    minutes: overrides.minutes ?? 45,
    dueAt: overrides.dueAt === undefined ? "2026-10-10T12:00:00.000Z" : overrides.dueAt,
    priority: overrides.priority ?? 80,
    sourceIds: overrides.sourceIds ?? ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"],
    status: overrides.status ?? "accepted",
    needsConfirmation: overrides.needsConfirmation ?? false,
  };
}

type Stored = Record<string, unknown>;

function db(options: {
  owner?: boolean;
  revokedSourceIds?: string[];
  seed?: Stored[];
} = {}) {
  const rows: Stored[] = [...(options.seed ?? [])];
  const owner = options.owner !== false;
  const revoked = new Set(options.revokedSourceIds ?? []);

  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");

    if (query.includes("FROM workspaces") && query.includes("FOR UPDATE")) {
      return Promise.resolve(owner ? [{ id: workspaceId }] : []);
    }

    if (query.includes("opening_import_receipts") && query.includes("revoked")) {
      const sourceIds = (values.find((v) => Array.isArray(v)) as string[] | undefined) ?? [];
      const hit = sourceIds.some((id) => revoked.has(id));
      return Promise.resolve(hit ? [{ "?column?": 1 }] : []);
    }

    if (query.includes("FROM opening_action_digest_decisions") && query.includes("client_key")) {
      const key = values[2];
      const found = rows.find(
        (r) =>
          r.workspace_id === workspaceId &&
          r.owner_user_id === ownerUserId &&
          r.client_key === key,
      );
      return Promise.resolve(found ? [found] : []);
    }

    if (
      query.includes("FROM opening_action_digest_decisions") &&
      query.includes("candidate_id") &&
      !query.includes("JOIN workspaces")
    ) {
      const id = values[2];
      const found = rows.find(
        (r) =>
          r.workspace_id === workspaceId &&
          r.owner_user_id === ownerUserId &&
          r.candidate_id === id,
      );
      return Promise.resolve(found ? [found] : []);
    }

    if (query.includes("JOIN workspaces") && query.includes("FROM opening_action_digest_decisions")) {
      return Promise.resolve(
        rows.filter(
          (r) => r.workspace_id === workspaceId && r.owner_user_id === ownerUserId,
        ),
      );
    }

    if (query.includes("DELETE FROM opening_action_digest_decisions")) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.workspace_id === workspaceId && rows[i]!.owner_user_id === ownerUserId) {
          rows.splice(i, 1);
        }
      }
      return Promise.resolve([]);
    }

    if (query.includes("INSERT INTO opening_action_digest_decisions")) {
      const id = values[0] as string;
      const status = values[11] as string;
      const clientKey = values[12] as string | null;
      if (rows.some((r) => r.candidate_id === id && r.workspace_id === workspaceId)) {
        const err = new Error("duplicate") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      if (
        clientKey &&
        rows.some(
          (r) =>
            r.workspace_id === workspaceId &&
            r.owner_user_id === ownerUserId &&
            r.client_key === clientKey,
        )
      ) {
        const err = new Error("duplicate client") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      const row: Stored = {
        id,
        workspace_id: values[1],
        owner_user_id: values[2],
        candidate_id: values[3],
        dedupe_key: values[4],
        title: values[5],
        minutes: values[6],
        due_at: values[7],
        priority: values[8],
        source_ids: values[9],
        needs_confirmation: values[10],
        status,
        client_key: clientKey,
        created_at: new Date("2026-10-09T10:00:00.000Z"),
        updated_at: new Date("2026-10-09T10:00:00.000Z"),
      };
      rows.push(row);
      return Promise.resolve([row]);
    }

    throw new Error(`Unexpected SQL: ${query}`);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  return { sql, rows };
}

describe("opening action digest decisions repository (unit)", () => {
  it("rejects pending upserts (overlay stores decisions only)", async () => {
    const { sql } = db();
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    await expect(
      repo.upsert(scope, candidate({ status: "pending" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("accept upsert is idempotent for same id+status+payload", async () => {
    const { sql } = db();
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    const first = await repo.upsert(scope, candidate({ status: "accepted" }));
    const second = await repo.upsert(scope, candidate({ status: "accepted" }));
    expect(second).toEqual(first);
    expect((await repo.list(scope))).toHaveLength(1);
  });

  it("conflicting status on same candidate id raises CONFLICT", async () => {
    const { sql } = db();
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    await repo.upsert(scope, candidate({ status: "accepted" }));
    await expect(
      repo.upsert(scope, candidate({ status: "rejected" })),
    ).rejects.toBeInstanceOf(OpeningPlanError);
    await expect(
      repo.upsert(scope, candidate({ status: "rejected" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recordDecision maps accept/reject and replays clientKey", async () => {
    const { sql } = db();
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    const key = "client-key-accept-1";
    const base = candidate({ status: "pending", needsConfirmation: true });
    const a = await repo.recordDecision(scope, {
      decision: "accept",
      candidate: base,
      clientKey: key,
    });
    expect(a.status).toBe("accepted");
    expect(a.needsConfirmation).toBe(false);
    const replay = await repo.recordDecision(scope, {
      decision: "accept",
      candidate: base,
      clientKey: key,
    });
    expect(replay.id).toBe(a.id);
  });

  it("refuses accept when a source is tied to a revoked connection", async () => {
    const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const { sql } = db({ revokedSourceIds: [sourceId] });
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    await expect(
      repo.recordDecision(scope, {
        decision: "accept",
        candidate: candidate({ status: "pending", sourceIds: [sourceId] }),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/revoked/i) });
  });

  it("allows reject even when source connection is revoked", async () => {
    const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const { sql } = db({ revokedSourceIds: [sourceId] });
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    const rejected = await repo.recordDecision(scope, {
      decision: "reject",
      candidate: candidate({
        id: randomUUID(),
        status: "pending",
        sourceIds: [sourceId],
      }),
    });
    expect(rejected.status).toBe("rejected");
  });

  it("rejects foreign workspace owner", async () => {
    const { sql } = db({ owner: false });
    const repo = createOpeningActionDigestDecisionsRepository(sql);
    await expect(
      repo.upsert(scope, candidate({ status: "rejected" })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
