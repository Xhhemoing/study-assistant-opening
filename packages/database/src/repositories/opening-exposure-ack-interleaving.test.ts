import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
vi.mock("./opening-learning-facts", () => ({ learningError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  learningIso: (v: unknown) => v == null ? null : String(v), lockWorkspaceLearningHistory: vi.fn(), nextLearningHistoryRevision: vi.fn(), nextWorkspaceLearningHistoryRevision: vi.fn() }));
vi.mock("./opening-study-context", () => ({ resolveOpeningStudyContext: vi.fn() }));
vi.mock("./opening-span-tutor-origin", () => ({ assertOpeningSpanTutorOriginCurrent: vi.fn() }));
vi.mock("./opening-course-route-origin", () => ({ assertOpeningCourseRouteCurrent: vi.fn() }));
vi.mock("./opening-learning-eligibility", () => ({ invalidateOpeningLearningEligibility: vi.fn() }));
import { createOpeningStudyExposureRepository } from "./opening-study-exposure";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Scope = { workspaceId: string; ownerUserId: string };
type Row = { id: string; workspace_id: string; owner_user_id: string; release_key: string; context_anchor: { purpose: string };
  exposure_origin: string; support_domain: string; generated_at: string; released_at: string | null; acknowledged_at: string | null; history_revision: number };
const scopeA = { workspaceId: uid(1), ownerUserId: uid(2) }, scopeB = { workspaceId: uid(3), ownerUserId: uid(4) };
const makeRow = (n: number, scope: Scope): Row => ({ id: uid(n), workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
  release_key: `assistant:receipt:${n}`, context_anchor: { purpose: "learning_help" }, exposure_origin: "assistant", support_domain: "unknown",
  generated_at: "2026-10-01T00:00:00.000Z", released_at: "2026-10-01T00:00:01.000Z", acknowledged_at: null, history_revision: n });
function deferred() {
  let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open };
}
// This scheduler controls completion order of isolated fake SQL calls. Its WHERE
// evaluates the actual supplied column/operator and RHS slots; it is not PG.
function scheduled(rows: Row[]) {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tag = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.reduce((s, part, i) => s + (i ? `$${i - 1}` : "") + part, "");
    const index = queries.push({ text, values }) - 1; entered[index]!.open(); await gates[index]!.promise;
    const set = text.match(/^\s*UPDATE\s+opening_help_exposures\s+SET\s+([\s\S]*?)\s+WHERE\s+/)?.[1]?.replace(/\s+/g, "");
    if (set !== "acknowledged_at=COALESCE(acknowledged_at,clock_timestamp())" && set !== "acknowledged_at=clock_timestamp()") {
      throw new Error("UNKNOWN ACK SET");
    }
    const where = text.match(/\bWHERE\s+([\s\S]*?)\s+RETURNING\s+\*/)?.[1];
    if (!where) throw new Error("UNKNOWN ACK WHERE");
    const conditions = where.split(/\s+AND\s+/).map(s => s.trim());
    const predicates = conditions.map(condition => {
      const equal = condition.match(/^(id|workspace_id|owner_user_id)\s*=\s*\$(\d+)$/);
      if (equal) return (row: Row) => row[equal[1] as "id" | "workspace_id" | "owner_user_id"] === values[Number(equal[2])];
      if (condition === "released_at IS NOT NULL") return (row: Row) => row.released_at !== null;
      throw new Error(`UNKNOWN predicate ${condition}`);
    });
    const matches = rows.filter(row => predicates.every(predicate => predicate(row)));
    for (const row of matches) {
      const now = `2026-10-01T00:00:0${index + 2}.000Z`;
      row.acknowledged_at = set === "acknowledged_at=clock_timestamp()" ? now : row.acknowledged_at ?? now;
    }
    return matches.map(row => structuredClone(row));
  });
  return { sql: tag as unknown as Sql, rows, gates, entered, queries };
}
const code = (result: PromiseSettledResult<unknown>) => result.status === "rejected" ? (result.reason as { code?: string }).code : "fulfilled";
describe("overlapping ACK calls retain per-call scope and receipt identity at an isolated SQL boundary", () => {
  it.each(["first then second", "second then first"] as const)("two owned receipts resolve correctly when %s completes first", async ordering => {
    const a = makeRow(11, scopeA), b = makeRow(12, scopeB), f = scheduled([a, b]), repo = createOpeningStudyExposureRepository(f.sql);
    const first = repo.acknowledge(scopeA, a.id), second = repo.acknowledge(scopeB, b.id);
    await Promise.all(f.entered.map(g => g.promise));
    if (ordering === "first then second") { f.gates[0]!.open(); await first; f.gates[1]!.open(); }
    else { f.gates[1]!.open(); await second; f.gates[0]!.open(); }
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra).toMatchObject({ id: a.id, releaseKey: a.release_key, historyRevision: 11, acknowledgedAt: "2026-10-01T00:00:02.000Z" });
    expect(rb).toMatchObject({ id: b.id, releaseKey: b.release_key, historyRevision: 12, acknowledgedAt: "2026-10-01T00:00:03.000Z" });
    expect(f.queries.map(q => q.values)).toEqual([[a.id, scopeA.workspaceId, scopeA.ownerUserId], [b.id, scopeB.workspaceId, scopeB.ownerUserId]]);
  });
  it.each(["foreign first", "owner first"] as const)("foreign caller cannot ACK while owner call overlaps: %s", async ordering => {
    const a = makeRow(11, scopeA), f = scheduled([a]), repo = createOpeningStudyExposureRepository(f.sql);
    const foreign = repo.acknowledge(scopeB, a.id), owner = repo.acknowledge(scopeA, a.id);
    const pending = Promise.allSettled([foreign, owner]); await Promise.all(f.entered.map(g => g.promise));
    if (ordering === "foreign first") { f.gates[0]!.open(); await foreign.catch(() => undefined); f.gates[1]!.open(); }
    else { f.gates[1]!.open(); await owner; f.gates[0]!.open(); }
    const [foreignResult, ownerResult] = await pending;
    expect(code(foreignResult!)).toBe("NOT_FOUND"); expect(code(ownerResult!)).toBe("fulfilled");
    expect(a.acknowledged_at).toBe("2026-10-01T00:00:03.000Z"); expect(a.history_revision).toBe(11);
  });
  it.each(["workspace", "owner"] as const)("a concurrent same-%s impostor cannot use the other scope's receipt", async same => {
    const a = makeRow(11, scopeA), impostor = same === "workspace" ? { ...scopeA, ownerUserId: uid(30) } : { ...scopeA, workspaceId: uid(31) };
    const f = scheduled([a]), repo = createOpeningStudyExposureRepository(f.sql);
    const results = Promise.allSettled([repo.acknowledge(impostor, a.id), repo.acknowledge(scopeA, a.id)]);
    await Promise.all(f.entered.map(g => g.promise)); f.gates[0]!.open(); f.gates[1]!.open();
    const [bad, good] = await results; expect(code(bad!)).toBe("NOT_FOUND"); expect(code(good!)).toBe("fulfilled");
    expect(a.acknowledged_at).toBe("2026-10-01T00:00:03.000Z");
  });
  it("overlapping repeat ACKs retain whichever timestamp the controlled scheduler applies first", async () => {
    const a = makeRow(11, scopeA), f = scheduled([a]), repo = createOpeningStudyExposureRepository(f.sql);
    const first = repo.acknowledge(scopeA, a.id), second = repo.acknowledge(scopeA, a.id);
    await Promise.all(f.entered.map(g => g.promise)); f.gates[1]!.open(); const laterCall = await second; f.gates[0]!.open(); const earlierCall = await first;
    expect(laterCall.acknowledgedAt).toBe("2026-10-01T00:00:03.000Z"); expect(earlierCall.acknowledgedAt).toBe(laterCall.acknowledgedAt);
    expect(a.history_revision).toBe(11);
  });
});
