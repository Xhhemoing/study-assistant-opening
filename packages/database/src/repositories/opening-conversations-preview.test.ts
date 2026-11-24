import { describe, expect, it, vi } from "vitest";
import { conversationSummarySchema } from "@aistudy/contracts";
import {
  LAST_TURN_PREVIEW_MAX,
  clipLastTurnPreview,
  createOpeningConversationRepository,
} from "./opening-conversations";
import { sqlSimulation, unexpected } from "./opening-resident-f11-sql-simulation";

const summaryBase = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "t",
  courseId: null as string | null,
  updatedAt: "2026-10-11T00:00:00.000Z",
};

describe("clipLastTurnPreview", () => {
  it("returns null for nullish", () => {
    expect(clipLastTurnPreview(null)).toBeNull();
    expect(clipLastTurnPreview(undefined)).toBeNull();
  });

  it("keeps strings within max", () => {
    const s = "a".repeat(LAST_TURN_PREVIEW_MAX);
    expect(clipLastTurnPreview(s)).toBe(s);
  });

  it("clips oversize previews so conversationSummarySchema.parse succeeds", () => {
    const oversize = "预".repeat(LAST_TURN_PREVIEW_MAX + 40);
    expect(oversize.length).toBeGreaterThan(LAST_TURN_PREVIEW_MAX);
    expect(() =>
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: oversize }),
    ).toThrow();

    const clipped = clipLastTurnPreview(oversize);
    expect(clipped).not.toBeNull();
    expect(clipped!.length).toBe(LAST_TURN_PREVIEW_MAX);
    expect(
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: clipped }).lastTurnPreview,
    ).toBe(clipped);
  });

  it("clips Postgres-char LEFT residue that exceeds Zod via emoji surrogate pairs", () => {
    // Simulate PG LEFT(..., 280) by characters: 280 emoji graphemes.
    // Each 😀 is one PG char but two UTF-16 code units → JS length 560.
    const pgCharClipped = "😀".repeat(LAST_TURN_PREVIEW_MAX);
    expect([...pgCharClipped].length).toBe(LAST_TURN_PREVIEW_MAX);
    expect(pgCharClipped.length).toBe(LAST_TURN_PREVIEW_MAX * 2);
    expect(() =>
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: pgCharClipped }),
    ).toThrow();

    const clipped = clipLastTurnPreview(pgCharClipped);
    expect(clipped!.length).toBe(LAST_TURN_PREVIEW_MAX);
    expect(
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: clipped }).lastTurnPreview,
    ).toBe(clipped);
  });
});

it("redacts a revoked answer in turns, previews and resume history without releasing its receipt", async () => {
  const id = "11111111-1111-4111-8111-111111111112";
  const scope = { workspaceId: id, ownerUserId: id };
  const hiddenText = "关联学习记录已更新或撤回，此回答内容不再显示。";
  const original = { id, conversation_id: summaryBase.id, role: "assistant", status: "complete", mode: "hint",
    created_at: summaryBase.updatedAt, text: "withdrawn answer", citations: [{ quote: "withdrawn quote" }],
    system_query: { invalid: true }, exposure_receipt: { id, released_at: null } };
  const { sql, queries } = sqlSimulation(query => {
    const statement = query.text;
    if (statement.startsWith("SELECT id, title, course_id")) return [{ id: summaryBase.id, title: "t", course_id: null, updated_at: summaryBase.updatedAt }];
    const guarded = statement.includes("FROM v3_bitemporal_misconception_edges") || statement.includes("JOIN v3_bitemporal_misconception_edges");
    if (guarded) {
      expect(statement).toContain("pg_input_is_valid((dt).intent_hash, 'json')");
      expect(statement).toContain("pg_input_is_valid((dt).intent_hash, 'jsonb')");
      expect(statement).toContain("count(*) = count(DISTINCT key) FROM json_each(payload.raw_json)");
      expect(statement).toMatch(/lineage\.course_id\s*=\s*\(\s*COALESCE\(conversation\.course_id/);
      expect(statement).toContain("t.context_anchor->>'courseId'");
      expect(statement).toContain("FROM opening_learning_sessions ls");
      expect(statement).toContain("e.privacy_epoch = w.privacy_epoch");
      expect(statement).toContain("e.valid_range @> payload.at AND e.tx_range @> payload.at");
      expect(statement).toContain("c.archived_at IS NULL");
    }
    if (statement.startsWith("SELECT c.id,")) return [{ id: summaryBase.id, title: "t", course_id: null, updated_at: summaryBase.updatedAt,
      preview_turn_id: guarded && statement.includes("THEN NULL ELSE t.id") ? null : id,
      last_turn_preview: guarded && query.values.includes(hiddenText) ? hiddenText : original.text }];
    if (statement.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (statement.includes("opening_workspace_history_revisions")) return [];

    if (statement.startsWith("SELECT t.id, t.conversation_id") || statement.startsWith("SELECT t.id,t.role")) {
      const redacted = guarded && statement.includes("display_authority.inactive_misconception");
      return [{ ...original, text: redacted && query.values.includes(hiddenText) ? hiddenText : original.text,
        citations: redacted && statement.includes("THEN '[]'::jsonb") ? [] : original.citations,
        system_query: redacted && statement.includes("THEN NULL ELSE t.system_query") ? null : original.system_query,
        exposure_receipt: redacted && statement.includes("THEN NULL ELSE to_jsonb(h)") ? null : original.exposure_receipt }];
    }
    return unexpected(query);
  });
  const begin = vi.fn(async (run: (tx: typeof sql) => Promise<void>) => run(sql));
  const repo = createOpeningConversationRepository(Object.assign(sql, { begin }));
  expect(await repo.listTurns(scope, summaryBase.id)).toMatchObject([{ text: hiddenText, citations: [], systemQuery: null }]);
  expect((await repo.listSummaries(scope))[0]?.lastTurnPreview).toBe(hiddenText);
  expect(await repo.loadContinuityTurns(scope, summaryBase.id)).toEqual([{ id, role: "assistant", text: hiddenText, citations: [] }]);
  expect(queries.filter(query => query.text.includes("AND t.id=ANY"))).toHaveLength(0);
  expect(begin).not.toHaveBeenCalled();
  await expect(repo.releaseReturnedTurnIds(scope, summaryBase.id, [id])).resolves.toEqual([{ id, role: "assistant", text: hiddenText, citations: [] }]);
  expect(begin).toHaveBeenCalledOnce();
  expect(queries.findIndex(query => query.text.includes("SELECT revision FROM opening_workspace_history_revisions")))
    .toBeLessThan(queries.findIndex(query => query.text.includes("AND t.id=ANY")));
});

it.each(["turns", "summaries", "resume"] as const)("rechecks %s after waiting for a pending exposure's history lock", async lane => {
  const scope = { workspaceId: summaryBase.id, ownerUserId: summaryBase.id };
  const hiddenText = "关联学习记录已更新或撤回，此回答内容不再显示。";
  const reads: boolean[] = [];
  let withdrew = false;
  const { sql, queries } = sqlSimulation(query => {
    const statement = query.text;
    if (statement.startsWith("SELECT id, title, course_id")) {
      return [{ id: summaryBase.id, title: "t", course_id: null, updated_at: summaryBase.updatedAt }];
    }
    if (statement.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (statement.startsWith("INSERT INTO opening_workspace_history_revisions")) return [];
    if (statement.startsWith("SELECT revision FROM opening_workspace_history_revisions")) {
      withdrew = true;
      return [];
    }
    const prefix = lane === "turns" ? "SELECT t.id, t.conversation_id" : lane === "resume" ? "SELECT t.id,t.role" : "SELECT c.id,";
    if (!statement.startsWith(prefix)) return unexpected(query);
    reads.push(withdrew);
    const guarded = statement.includes("WITH RECURSIVE mem_deps(dep_id)")
      && statement.includes("(dm).course_id") && statement.includes("(dt).intent_hash")
      && statement.includes("display_authority.inactive_misconception");
    const visible = !withdrew || !guarded;
    const text = visible ? "answer based on a memory" : hiddenText;
    return [{ id: summaryBase.id, conversation_id: summaryBase.id, role: "assistant", mode: "hint",
      status: "complete", title: "t", created_at: summaryBase.updatedAt, updated_at: summaryBase.updatedAt,
      text, last_turn_preview: text, citations: [], pending_exposure_ids: visible ? [summaryBase.id] : [],
      exposure_receipt: visible ? { id: summaryBase.id, released_at: null } : null }];
  });
  const repo = createOpeningConversationRepository(Object.assign(sql, { begin: (run: (tx: typeof sql) => unknown) => run(sql) }));

  if (lane === "turns") await expect(repo.listTurns(scope, summaryBase.id)).resolves.toMatchObject([{ text: hiddenText }]);
  else if (lane === "summaries") await expect(repo.listSummaries(scope)).resolves.toMatchObject([{ lastTurnPreview: hiddenText }]);
  else {
    await expect(repo.loadContinuityTurns(scope, summaryBase.id)).resolves.toMatchObject([{ text: "answer based on a memory" }]);
    await expect(repo.releaseReturnedTurnIds(scope, summaryBase.id, [summaryBase.id])).resolves.toMatchObject([{ text: hiddenText, citations: [] }]);
  }
  expect(reads).toEqual([false, true]);
  expect(queries.some(query => query.text.startsWith("UPDATE opening_help_exposures"))).toBe(false);
});

it.each(["anchor", "learning session"] as const)("keeps a standalone answer scoped to its %s visible", async binding => {
  const scope = { workspaceId: summaryBase.id, ownerUserId: summaryBase.id };
  const { sql } = sqlSimulation(query => {
    const statement = query.text;
    if (!statement.startsWith("SELECT c.id,")) return unexpected(query);
    const effectiveCourse = statement.includes("COALESCE(conversation.course_id")
      && (binding === "anchor" ? statement.includes("t.context_anchor->>'courseId'")
        : statement.includes("ls.id = dt.learning_session_id") && statement.includes("ls.owner_user_id = conversation.owner_user_id"));
    return [{ id: summaryBase.id, title: "t", course_id: null, updated_at: summaryBase.updatedAt,
      last_turn_preview: effectiveCourse ? "course-bound answer" : "answer hidden" }];
  });
  await expect(createOpeningConversationRepository(sql).listSummaries(scope))
    .resolves.toMatchObject([{ lastTurnPreview: "course-bound answer" }]);
});
