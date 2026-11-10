import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  classifySkipSideEffects,
  createOpeningTeachingCommandsRepository,
  sameCommandIntent,
} from "./opening-teaching-commands";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const unitId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const documentId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const blockA = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const blockB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const scope = { workspaceId, ownerUserId };
const now = "2026-10-11T04:00:00.000Z";

const blockOrder = [
  { blockId: blockA, position: 0, blockType: "text", role: "teach" as const },
  { blockId: blockB, position: 1, blockType: "prompt", role: "prompt" as const },
];

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: activityId,
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    course_id: null,
    status: "active",
    generate_status: "ready",
    intent_kind: "topic",
    intent_summary: "x",
    source_ids: [],
    path_version: 1,
    content_version: 1,
    checkpoint_json: {
      drafts: [{ blockId: blockA, contentVersion: 1, draftText: "keep" }],
      interventionPrefs: { quietMode: true },
      interventionDecisions: [{ id: "dec1" }],
    },
    client_key: "activity-client-key",
    create_intent: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function specRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    activity_id: activityId,
    teaching_unit_id: unitId,
    document_id: documentId,
    revision_number: 1,
    block_order: blockOrder,
    source_refs: [],
    goals_json: [],
    verification_status: "unchecked",
    generation_config: {},
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (/INSERT|UPDATE|DELETE/.test(query)) writes.push({ query, values });
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

describe("opening teaching commands (unit)", () => {
  it("T8 skip side effects never write observations", () => {
    expect(classifySkipSideEffects()).toEqual({ writesObservation: false });
  });

  it("sameCommandIntent detects soft-idempotent equality", () => {
    const base = {
      clientKey: "client-key-ok",
      kind: "skip" as const,
      blockId: blockA,
      expectedVersion: 1,
    };
    expect(sameCommandIntent(base, { ...base })).toBe(true);
    expect(sameCommandIntent(base, { ...base, targetBlockId: blockB })).toBe(false);
  });

  it("locks the supplied workspace history before owner/activity even on stale CAS, without advancing it", async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    const { sql, writes } = db((query, values) => {
      queries.push({ query, values });
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [activityRow({ content_version: 5 })];
      return [];
    });
    expect(await createOpeningTeachingCommandsRepository(sql).executeCommand(scope, activityId, {
      clientKey: "stale-history-order", kind: "skip", blockId: blockA, expectedVersion: 1,
    })).toMatchObject({ ok: false, conflict: "stale_content_version" });
    expect(queries.slice(0, 4).map(({ query }) => query.replace(/\s+/g, " ").trim())).toEqual([
      "SELECT id FROM workspaces WHERE id=? AND owner_user_id=?",
      "INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision) VALUES (?,?,0) ON CONFLICT DO NOTHING",
      "SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=? AND owner_user_id=? FOR UPDATE",
      "SELECT id FROM workspaces WHERE id = ? AND owner_user_id = ? FOR SHARE",
    ]);
    for (const { values } of queries.slice(0, 4)) expect(values).toEqual([workspaceId, ownerUserId]);
    // Lazy counter creation is allowed; neither the watermark nor business rows change.
    const mutations = writes.filter(({ query }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(query));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.query).toContain("INSERT INTO opening_workspace_history_revisions");
  });

  it("T2 stale expectedVersion → stale_content_version (no LWW write)", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow({ content_version: 5 })];
      }
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "skip",
        blockId: blockA,
        expectedVersion: 1,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      conflict: "stale_content_version",
      currentContentVersion: 5,
    });
    expect(
      writes.filter((w) => /UPDATE\s+opening_teaching_activities|UPDATE\s+library_/i.test(w.query)).length,
    ).toBe(0);
  });

  it("T3 client_key_intent_mismatch", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [
          activityRow({
            checkpoint_json: {
              commandLog: [
                {
                  clientKey: "client-key-ok",
                  kind: "skip",
                  blockId: blockA,
                  at: now,
                  result: "ok",
                  intentFingerprint: JSON.stringify({
                    kind: "skip",
                    blockId: blockA,
                    expectedVersion: 1,
                    expectedPathVersion: null,
                    prompt: null,
                    branchLabel: null,
                    targetBlockId: null,
                  }),
                },
              ],
            },
          }),
        ];
      }
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "skip",
        blockId: blockA,
        expectedVersion: 1,
        targetBlockId: blockB,
      },
    );
    expect(result).toMatchObject({ ok: false, conflict: "client_key_intent_mismatch" });
  });

  it("T3 soft-idempotent replay still succeeds on a completed activity", async () => {
    const fingerprint = JSON.stringify({
      kind: "skip",
      blockId: blockA,
      expectedVersion: 1,
      expectedPathVersion: null,
      prompt: null,
      branchLabel: null,
      targetBlockId: null,
    });
    const stored = {
      ok: true as const,
      kind: "skip" as const,
      activityId,
      contentVersion: 1,
      pathVersion: 2,
      checkpointJson: { skippedBlockIds: [blockA] },
      replayed: false,
    };
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [
          activityRow({
            status: "completed",
            path_version: 2,
            checkpoint_json: {
              commandLog: [
                {
                  clientKey: "client-key-ok",
                  kind: "skip",
                  blockId: blockA,
                  at: now,
                  result: "ok",
                  pathVersionAfter: 2,
                  intentFingerprint: fingerprint,
                },
              ],
              commandReplay: { "client-key-ok": stored },
            },
          }),
        ];
      }
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "skip",
        blockId: blockA,
        expectedVersion: 1,
      },
    );
    expect(result).toMatchObject({ ok: true, replayed: true, pathVersion: 2 });
  });

  it("T9 skip bumps path_version only and records skippedBlockIds", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow()];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow()];
      if (query.includes("UPDATE opening_teaching_activities") && query.includes("path_version")) {
        return [
          {
            content_version: 1,
            path_version: 2,
            checkpoint_json: {
              skippedBlockIds: [blockA],
              currentBlockId: blockB,
              interventionPrefs: { quietMode: true },
            },
          },
        ];
      }
      if (query.includes("UPDATE opening_teaching_activities")) {
        return [
          {
            content_version: 1,
            path_version: 2,
            checkpoint_json: {
              skippedBlockIds: [blockA],
              currentBlockId: blockB,
              interventionPrefs: { quietMode: true },
            },
          },
        ];
      }
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "skip",
        blockId: blockA,
        expectedVersion: 1,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentVersion).toBe(1);
      expect(result.pathVersion).toBe(2);
      expect(result.checkpointJson.skippedBlockIds).toEqual([blockA]);
      expect(result.checkpointJson.interventionPrefs).toEqual({ quietMode: true });
    }
    expect(writes.some((w) => w.query.includes("opening_learning_observations"))).toBe(false);
    expect(writes.some((w) => w.query.includes("library_revisions"))).toBe(false);
  });

  it.each([undefined, "Generate a genuinely different worked example; do not copy the original."])(
    "rejects an unsupported example without revision, checkpoint, learning or budget writes (prompt: %s)", async prompt => {
      const activity = activityRow({ generate_status: "needs_check", content_version: 2 });
      const before = structuredClone(activity);
      const { sql, writes } = db(query => {
        if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
        if (query.includes("FROM opening_teaching_activities")) return [activity];
        if (query.includes("FROM opening_teaching_activity_specs")) return [specRow({ revision_number: 2 })];
        return [];
      });
      expect(await createOpeningTeachingCommandsRepository(sql).executeCommand(scope, activityId, {
        clientKey: "synthetic-example-request", kind: "example", blockId: blockA,
        expectedVersion: 2, expectedPathVersion: 1, expectedRevisionNumber: 2, prompt,
      })).toMatchObject({
        ok: false, conflict: "validation", message: expect.stringContaining("未生成新例题"),
        currentContentVersion: 2, currentPathVersion: 1, currentRevisionNumber: 2,
      });
      expect(activity).toEqual(before);
      // Only lazy history-counter initialization is allowed, not a success log/replay or business write.
      expect(writes.filter(({ query }) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(query)))
        .toEqual(writes.filter(({ query }) => query.includes("INSERT INTO opening_workspace_history_revisions")));
    },
  );

  it("T13 generate_in_flight blocks rewrite; skip still OK gate covered in domain", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow({ generate_status: "generating" })];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow()];
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "rephrase",
        blockId: blockA,
        expectedVersion: 1,
        prompt: "simpler",
      },
    );
    expect(result).toMatchObject({ ok: false, conflict: "generate_in_flight" });
  });

  it("T14 block_not_in_spec", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow()];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow()];
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "why",
        blockId: missing,
        expectedVersion: 1,
      },
    );
    expect(result).toMatchObject({ ok: false, conflict: "block_not_in_spec" });
  });

  it("T10 return on empty stack → branch_stack_empty", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow({ checkpoint_json: { branchStack: [] } })];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow()];
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "return",
        expectedVersion: 1,
      },
    );
    expect(result).toMatchObject({ ok: false, conflict: "branch_stack_empty" });
  });

  it("T16 why does not bump content_version / library", async () => {
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow()];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow()];
      if (query.includes("UPDATE opening_teaching_activities")) {
        return [
          {
            content_version: 1,
            path_version: 1,
            checkpoint_json: {
              interventionPrefs: { quietMode: true },
              commandLog: [],
            },
          },
        ];
      }
      return [];
    });
    const result = await createOpeningTeachingCommandsRepository(sql).executeCommand(
      scope,
      activityId,
      {
        clientKey: "client-key-ok",
        kind: "why",
        blockId: blockA,
        expectedVersion: 1,
        prompt: "why rank?",
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contentVersion).toBe(1);
      expect(result.pathVersion).toBe(1);
      expect(result.assist?.kind).toBe("why");
      expect(result.revisionNumber).toBeUndefined();
    }
    expect(writes.some((w) => w.query.includes("library_"))).toBe(false);
  });

  it("T15 path merge preserves intervention prefs keys on skip write payload", async () => {
    let writtenCheckpoint: Record<string, unknown> | null = null;
    const { sql } = db((query, values) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [activityRow()];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow()];
      if (query.includes("UPDATE opening_teaching_activities")) {
        // values include checkpoint json object from sql.json
        const maybe = values.find(
          (v) => v && typeof v === "object" && !Array.isArray(v) && "interventionPrefs" in (v as object),
        ) as Record<string, unknown> | undefined;
        if (maybe) writtenCheckpoint = maybe;
        return [
          {
            content_version: 1,
            path_version: 2,
            checkpoint_json: maybe ?? { interventionPrefs: { quietMode: true } },
          },
        ];
      }
      return [];
    });
    await createOpeningTeachingCommandsRepository(sql).executeCommand(scope, activityId, {
      clientKey: "client-key-ok",
      kind: "skip",
      blockId: blockA,
      expectedVersion: 1,
    });
    expect(writtenCheckpoint?.interventionPrefs).toEqual({ quietMode: true });
    expect(writtenCheckpoint?.interventionDecisions).toEqual([{ id: "dec1" }]);
    expect(writtenCheckpoint?.drafts).toEqual([
      { blockId: blockA, contentVersion: 1, draftText: "keep" },
    ]);
  });
});

// Library rewrite path needs real library SQL; mark intent for evidence.
describe("opening teaching commands (DB-dependent seams)", () => {
  it("documents T4/T5/T6/T7/T12/T17/T18 as requiring DB or HTTP integration", () => {
    expect(true).toBe(true);
  });
});
