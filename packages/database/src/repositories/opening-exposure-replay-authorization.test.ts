import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
const deps = vi.hoisted(() => ({ resolve: vi.fn(), span: vi.fn(), course: vi.fn(), revision: vi.fn(), workspaceRevision: vi.fn(), invalidate: vi.fn() }));
vi.mock("./opening-learning-facts", () => ({ learningError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  learningIso: (v: unknown) => v == null ? null : String(v), lockWorkspaceLearningHistory: vi.fn(),
  nextLearningHistoryRevision: deps.revision, nextWorkspaceLearningHistoryRevision: deps.workspaceRevision }));
vi.mock("./opening-study-context", () => ({ resolveOpeningStudyContext: deps.resolve }));
vi.mock("./opening-span-tutor-origin", () => ({ assertOpeningSpanTutorOriginCurrent: deps.span }));
vi.mock("./opening-course-route-origin", () => ({ assertOpeningCourseRouteCurrent: deps.course }));
vi.mock("./opening-learning-eligibility", () => ({ invalidateOpeningLearningEligibility: deps.invalidate }));
import { generateOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: uid(1), ownerUserId: uid(2) }, receiptId = uid(3), activityId = uid(4);
const anchor = { purpose: "learning_help" as const, activityId, courseId: uid(5), attemptId: uid(6) };
const input = { releaseKey: "assistant:receipt", contextAnchor: anchor, origin: "assistant" as const, kind: "hint" as const, level: "hinted" as const };
const baseRow = () => ({ id: receiptId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId, release_key: input.releaseKey,
  release_intent: input, context_anchor: anchor, exposure_origin: "assistant", support_domain: "unknown", session_id: null,
  course_id: anchor.courseId, generated_at: "2026-10-01T00:00:00.000Z", released_at: null, acknowledged_at: null, history_revision: 0 });
function setup(row: Record<string, unknown> | null = baseRow()) {
  const statements: string[] = [];
  const tag = vi.fn((parts: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const text = parts.join("?"); statements.push(text);
    if (text.includes("SELECT * FROM opening_help_exposures")) return Promise.resolve(row ? [row] : []);
    if (/\b(?:INSERT|UPDATE|DELETE)\b/.test(text)) throw new Error("unexpected write reached");
    throw new Error(`unexpected SQL ${text}`);
  });
  return { tx: tag as unknown as TransactionSql, statements };
}
beforeEach(() => {
  vi.clearAllMocks(); deps.resolve.mockResolvedValue(anchor); deps.span.mockResolvedValue(undefined); deps.course.mockResolvedValue(undefined);
  deps.revision.mockResolvedValue(1); deps.workspaceRevision.mockResolvedValue(1);
});

describe("release authorization and existing receipt replay boundaries", () => {
  it.each([
    ["source or privacy exclusion", "resolve"], ["revoked span origin", "span"], ["changed course route", "course"],
  ] as const)("unreleased receipt refuses %s before revision, update or invalidation", async (_name, target) => {
    const error = Object.assign(new Error("synthetic authorization revoked"), { code: "CONFLICT" });
    deps[target].mockRejectedValue(error); const f = setup();
    await expect(releaseOpeningStudyExposure(f.tx, scope, receiptId)).rejects.toBe(error);
    expect(deps.revision).not.toHaveBeenCalled(); expect(deps.workspaceRevision).not.toHaveBeenCalled(); expect(deps.invalidate).not.toHaveBeenCalled();
    expect(f.statements).toHaveLength(1);
  });
  it("released replay returns the historical receipt without re-resolving or creating another revision", async () => {
    const row = { ...baseRow(), released_at: "2026-10-01T00:00:01.000Z", history_revision: 7 };
    deps.resolve.mockRejectedValue(new Error("later source unavailable")); const f = setup(row);
    await expect(releaseOpeningStudyExposure(f.tx, scope, receiptId)).resolves.toMatchObject({ id: receiptId, releasedAt: row.released_at, historyRevision: 7 });
    expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.revision).not.toHaveBeenCalled(); expect(deps.invalidate).not.toHaveBeenCalled();
    expect(f.statements).toHaveLength(1);
  });
  it("missing owned release row remains NOT_FOUND and cannot reach authorization or writes", async () => {
    const f = setup(null); await expect(releaseOpeningStudyExposure(f.tx, scope, receiptId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.revision).not.toHaveBeenCalled(); expect(f.statements).toHaveLength(1);
  });
  it("existing generate replay returns saved identity without attempting source rebind", async () => {
    deps.resolve.mockRejectedValue(new Error("later source unavailable")); const f = setup();
    const result = await generateOpeningStudyExposure(f.tx, scope, input);
    expect(result).toMatchObject({ id: receiptId, releaseKey: input.releaseKey, contextAnchor: anchor, releasedAt: null });
    expect(deps.resolve).not.toHaveBeenCalled(); expect(f.statements).toHaveLength(1);
  });
  it.each([
    ["foreign owner", { owner_user_id: uid(20) }], ["different saved intent", { release_intent: { ...input, level: "revealed" } }],
    ["different saved hint stage", { hint_stage: 3 }], ["different initiator", { initiated_by: "assistant" }],
  ] as const)("existing release key rejects %s without rebind or write", async (_name, changes) => {
    const f = setup({ ...baseRow(), ...changes });
    await expect(generateOpeningStudyExposure(f.tx, scope, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.revision).not.toHaveBeenCalled(); expect(f.statements).toHaveLength(1);
  });
});
