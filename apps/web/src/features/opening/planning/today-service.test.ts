import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../auth/service";
import { createTodayResumeReader, loadTodayResumeState, type TodayResumeReader } from "./today-service";

const scope = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const other = {
  workspaceId: scope.workspaceId,
  ownerUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const owned = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "线性代数答疑",
  courseId: "22222222-2222-4222-8222-222222222222",
  lastUserText: "如何判断矩阵可逆？",
  sourceVersions: { "33333333-3333-4333-8333-333333333333": 4 },
  currentPage: 7,
};

function reader(latest = owned, pending = 0): TodayResumeReader {
  return {
    latestOwned: vi.fn(async (asked) => (asked.ownerUserId === scope.ownerUserId ? latest : null)),
    pendingCandidateCount: vi.fn(async (asked) => (asked.ownerUserId === scope.ownerUserId ? pending : 0)),
    pendingCandidates: vi.fn(async () => []),
  };
}

describe("loadTodayResumeState", () => {
  it("does not read another owner's conversation", async () => {
    const facts = reader();
    const state = await loadTodayResumeState({ scope: other, reader: facts });
    expect(facts.latestOwned).toHaveBeenCalledWith(other);
    expect(state).toEqual({ kind: "empty" });
  });

  it("counts real pending candidates and keeps the continue item", async () => {
    const state = await loadTodayResumeState({ scope, reader: reader(owned, 2) });
    expect(state.kind).toBe("ready");
    expect(state.pendingReviews?.count).toBe(2);
    expect(state.continueItem).toMatchObject({
      conversationId: owned.id,
      sourceVersions: owned.sourceVersions,
      currentPage: 7,
      lastUserText: owned.lastUserText,
    });
  });

  it("returns empty only when the owner has no saved conversation or candidate", async () => {
    const state = await loadTodayResumeState({ scope, reader: reader(null as never, 0) });
    expect(state).toEqual({ kind: "empty" });
  });

  it("propagates a read failure as error instead of empty", async () => {
    const facts: TodayResumeReader = {
      latestOwned: vi.fn(async () => {
        throw new Error("db down");
      }),
      pendingCandidateCount: vi.fn(async () => 0),
      pendingCandidates: vi.fn(async () => []),
    };
    const state = await loadTodayResumeState({ scope, reader: facts });
    expect(state.kind).toBe("error");
  });

  it("maps an authentication failure to loggedOut", async () => {
    const facts: TodayResumeReader = {
      latestOwned: vi.fn(async () => {
        throw new ApiError("UNAUTHENTICATED", "login required", 401);
      }),
      pendingCandidateCount: vi.fn(async () => 0),
      pendingCandidates: vi.fn(async () => []),
    };
    expect((await loadTodayResumeState({ scope, reader: facts })).kind).toBe("loggedOut");
  });
});

describe("createTodayResumeReader", () => {
  it("scopes the latest turn to the owner and the last user role", async () => {
    const sql = Object.assign(vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []), {
      json: (value: unknown) => value,
    });
    const resume = createTodayResumeReader(sql as never);
    await expect(resume.latestOwned(scope)).resolves.toBeNull();
    const query = String((sql.mock.calls[0]?.[0] as TemplateStringsArray).join(" "));
    expect(query).toContain("c.workspace_id");
    expect(query).toContain("c.owner_user_id");
    expect(query).toContain("role = 'user'");
    expect(query).toContain("ORDER BY created_at DESC");
    expect(query).toContain("LIMIT 1");
    expect(query).not.toContain("opening_assistant_candidates");
    expect(sql.mock.calls[0]?.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId]);
  });

  it("surfaces combined assistant/retest read failures instead of an empty count", async () => {
    const sql = Object.assign(vi.fn(async () => { throw new Error("database unavailable"); }), { json: (value: unknown) => value });
    await expect(createTodayResumeReader(sql as never).pendingCandidateCount(scope)).rejects.toThrow("database unavailable");
  });
});

const sourceId = "33333333-3333-4333-8333-333333333333";
const secondSourceId = "44444444-4444-4444-8444-444444444444";
const chunkId = "55555555-5555-4555-8555-555555555555";
const storedTurn = { id: owned.id, title: owned.title, course_id: owned.courseId,
  last_user_text: owned.lastUserText, source_ids: [sourceId], source_versions: { [sourceId]: 4 }, current_page: 7, chunk_id: null };
const readableSource = { id: sourceId, version: 4, upload_state: "uploaded", parse_state: "ready", availability: "available", asset_deleted_at: null, ai_excluded: false };
const readableChunk = { id: chunkId, source_id: sourceId, source_version: 4, page: 7 };
function storedReader(input: { turn?: Record<string, unknown>; sources?: Record<string, unknown>[]; chunks?: Record<string, unknown>[] } = {}) {
  const sql = Object.assign(vi.fn((parts: TemplateStringsArray | unknown[]) => {
    if (!("raw" in parts)) return parts;
    const query = parts.join(" ");
    if (query.includes("FROM opening_conversations")) return Promise.resolve([{ ...storedTurn, ...input.turn }]);
    if (query.includes("FROM opening_sources")) return Promise.resolve(input.sources ?? [readableSource]);
    if (query.includes("FROM opening_source_chunks")) return Promise.resolve(input.chunks ?? [readableChunk]);
    return Promise.resolve([]);
  }), { json: (value: unknown) => value });
  return createTodayResumeReader(sql as never);
}

describe("Today stored material recovery", () => {
  it.each([
    ["missing source", []],
    ["permanently deleted source", [{ ...readableSource, asset_deleted_at: "2026-09-30T00:00:00Z" }]],
    ["changed source version", [{ ...readableSource, version: 5 }]],
    ["unavailable version", [{ ...readableSource, availability: "unavailable" }]],
    ["unknown version", [{ ...readableSource, availability: "unknown" }]],
    ["incomplete upload", [{ ...readableSource, upload_state: "pending" }]],
    ["unfinished parsing", [{ ...readableSource, parse_state: "running" }]],
  ])("keeps conversation and user text without restoring %s", async (_label, sources) => {
    const latest = await storedReader({ sources: sources as Record<string, unknown>[] }).latestOwned(scope);
    expect(latest).toMatchObject({ id: owned.id, lastUserText: owned.lastUserText, currentPage: null });
    expect(latest?.sourceVersions).toEqual({});
  });

  it("keeps an exact readable version and validated physical page", async () => {
    await expect(storedReader().latestOwned(scope)).resolves.toMatchObject({ sourceVersions: owned.sourceVersions, currentPage: 7 });
  });

  it("keeps current legacy material without inventing a historical version", async () => {
    await expect(storedReader({ sources: [{ ...readableSource, availability: null }] }).latestOwned(scope)).resolves.toMatchObject({ sourceVersions: owned.sourceVersions, currentPage: 7 });
  });

  it.each([null, [], { [sourceId]: "4" }, { [sourceId]: -1 }, { [sourceId]: 4.5 }])("does not turn malformed saved versions into current material", async versions => {
    const latest = await storedReader({ turn: { source_versions: versions } }).latestOwned(scope);
    expect(latest?.sourceVersions).toEqual({});
    expect(latest?.currentPage).toBeNull();
  });

  it("does not assign a removed material's page to a remaining material", async () => {
    const latest = await storedReader({
      turn: { source_ids: [sourceId, secondSourceId], source_versions: { [sourceId]: 4, [secondSourceId]: 4 } },
      sources: [{ ...readableSource, id: secondSourceId }],
      chunks: [{ ...readableChunk, source_id: secondSourceId }],
    }).latestOwned(scope);
    expect(latest?.sourceVersions).toEqual({ [secondSourceId]: 4 });
    expect(latest?.currentPage).toBeNull();
  });

  it("requires a real page and rejects a stale chunk even if that page exists elsewhere", async () => {
    await expect(storedReader({ chunks: [{ ...readableChunk, page: 9 }] }).latestOwned(scope)).resolves.toMatchObject({ sourceVersions: owned.sourceVersions, currentPage: null });
    await expect(storedReader({ turn: { chunk_id: "66666666-6666-4666-8666-666666666666" } }).latestOwned(scope)).resolves.toMatchObject({ sourceVersions: owned.sourceVersions, currentPage: null });
    expect((await storedReader({ chunks: [] }).latestOwned(scope))?.sourceVersions).toEqual({});
  });

  it("retains AI-excluded material for personal reading with an explicit manual count", async () => {
    const latest = await storedReader({ sources: [{ ...readableSource, ai_excluded: true }] }).latestOwned(scope);
    expect(latest?.sourceVersions).toEqual({});
    expect(latest).toMatchObject({ currentPage: null, manualSourceCount: 1, lastUserText: owned.lastUserText });
  });
});
