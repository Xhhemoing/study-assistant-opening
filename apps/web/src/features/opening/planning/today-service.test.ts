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
    const sql = Object.assign(vi.fn(async () => []), {
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
