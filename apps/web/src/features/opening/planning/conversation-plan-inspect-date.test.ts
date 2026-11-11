import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { createConversationPlanService } from "./conversation-plan-service";

const io = vi.hoisted(() => ({ candidate: vi.fn(), settingsFactory: vi.fn(), settings: vi.fn(), propose: vi.fn() }));
vi.mock("@aistudy/database", () => ({ readOpeningConversationPlanCandidate: io.candidate, createOpeningPlanningSettingsRepository: io.settingsFactory,
  proposeOpeningLocalPlan: io.propose, admitOpeningConversationPlanReplay: vi.fn(), assertOpeningConversationPlanCourse: vi.fn(),
  conversationPlanSuggestion: vi.fn(), OpeningPlanError: class extends Error {} }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, candidateId = id(3), courseId = id(4);
const candidate = { id: candidateId, sourceTurnId: id(5), sourceIds: [id(6)], title: "Saved suggestion", minutes: 25, dueText: "tomorrow morning" };
const now = () => new Date("2026-11-11T00:30:00.000Z");
function database({ state = [{ accepted_version: "7" }] as Record<string, unknown>[], courses = [{ id: courseId, title: "Owned course" }], fault = "" } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [], error = new Error("inspect storage failed");
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim(); calls.push({ sql, values });
    if (fault && sql.startsWith(fault)) throw error;
    if (sql.startsWith("SELECT accepted_version")) return state;
    if (sql.startsWith("SELECT id, title FROM courses")) return courses;
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const tx = query as unknown as TransactionSql, pool = vi.fn(() => { throw new Error("inspect must use tx"); });
  const begin = vi.fn(async (fn: (value: TransactionSql) => unknown) => fn(tx));
  const sql = Object.assign(pool, { begin }) as unknown as Sql;
  return { sql, tx, pool, calls, begin, error };
}
beforeEach(() => { vi.resetAllMocks(); io.candidate.mockResolvedValue(candidate); io.settingsFactory.mockReturnValue({ get: io.settings });
  io.settings.mockResolvedValue({ settings: { timeZone: "UTC" }, invalidStoredSettings: false }); });

describe("conversation plan inspect: server clock → configured date → accepted version", () => {
  it.each([
    ["America/Los_Angeles", "2026-11-10"], ["Asia/Tokyo", "2026-11-11"], ["Pacific/Honolulu", "2026-11-10"],
  ])("queries the local day in %s, not the UTC timestamp date", async (timeZone, date) => {
    const f = database(); io.settings.mockResolvedValueOnce({ settings: { timeZone }, invalidStoredSettings: false });
    const result = await createConversationPlanService(f.sql, { now }).inspect(scope, candidateId);
    expect(result).toEqual({ kind: "clarification", candidate: { id: candidateId, version: 0, title: candidate.title, minutes: 25, dueText: candidate.dueText },
      date, timeZone, planningReady: true, acceptedVersion: 7, courses: [{ id: courseId, name: "Owned course" }], missing: ["course"] });
    expect(io.candidate).toHaveBeenCalledExactlyOnceWith(f.tx, scope, candidateId);
    expect(io.settingsFactory).toHaveBeenCalledExactlyOnceWith(f.tx); expect(io.settings).toHaveBeenCalledExactlyOnceWith(scope);
    expect(f.calls[0]).toEqual({ sql: "SELECT accepted_version FROM opening_plan_state WHERE workspace_id=? AND day=?::date", values: [scope.workspaceId, date] });
    expect(f.calls[1]).toEqual({ sql: "SELECT id, title FROM courses WHERE workspace_id=? AND archived_at IS NULL ORDER BY title, id LIMIT 100", values: [scope.workspaceId] });
    expect(f.pool).not.toHaveBeenCalled(); expect(io.propose).not.toHaveBeenCalled(); expect(f.begin).toHaveBeenCalledOnce();
  });
  it("falls back to Asia/Shanghai for missing settings, returns version zero for absent state and asks for both missing choices", async () => {
    const f = database({ state: [], courses: [] }); io.settings.mockResolvedValueOnce({ settings: null, invalidStoredSettings: false });
    io.candidate.mockResolvedValueOnce({ ...candidate, minutes: null });
    const result = await createConversationPlanService(f.sql, { now: () => new Date("2026-11-10T17:30:00.000Z") }).inspect(scope, candidateId);
    expect(result).toMatchObject({ date: "2026-11-11", timeZone: "Asia/Shanghai", planningReady: false, acceptedVersion: 0, courses: [], missing: ["course", "minutes"] });
    expect(f.calls[0]!.values).toEqual([scope.workspaceId, "2026-11-11"]);
  });
  it("uses stored timezone for inspection but does not claim readiness when settings are flagged invalid", async () => {
    const f = database(); io.settings.mockResolvedValueOnce({ settings: { timeZone: "America/Los_Angeles" }, invalidStoredSettings: true });
    const result = await createConversationPlanService(f.sql, { now }).inspect(scope, candidateId);
    expect(result).toMatchObject({ date: "2026-11-10", timeZone: "America/Los_Angeles", planningReady: false });
  });
  it("reads the injected clock for each inspection instead of retaining a factory-time day", async () => {
    const f = database(), clock = vi.fn().mockReturnValueOnce(new Date("2026-11-10T23:59:00.000Z")).mockReturnValueOnce(new Date("2026-11-11T00:01:00.000Z"));
    const s = createConversationPlanService(f.sql, { now: clock });
    expect((await s.inspect(scope, candidateId)).date).toBe("2026-11-10");
    expect((await s.inspect(scope, candidateId)).date).toBe("2026-11-11");
    expect(clock).toHaveBeenCalledTimes(2); expect(f.calls.filter(call => call.sql.startsWith("SELECT accepted_version")).map(call => call.values[1])).toEqual(["2026-11-10", "2026-11-11"]);
  });
  it("does not consult settings or plan state if saved-candidate admission fails", async () => {
    const f = database(), failure = new Error("candidate unavailable"); io.candidate.mockRejectedValueOnce(failure);
    await expect(createConversationPlanService(f.sql, { now }).inspect(scope, candidateId)).rejects.toBe(failure);
    expect(io.settings).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(io.propose).not.toHaveBeenCalled();
  });
  it.each(["settings", "state", "courses"])("propagates %s read failure instead of fabricating a ready inspection", async boundary => {
    const f = database({ fault: boundary === "state" ? "SELECT accepted_version" : boundary === "courses" ? "SELECT id, title" : "" });
    if (boundary === "settings") io.settings.mockRejectedValueOnce(f.error);
    await expect(createConversationPlanService(f.sql, { now }).inspect(scope, candidateId)).rejects.toBe(f.error);
    expect(f.calls).toHaveLength(boundary === "settings" ? 0 : boundary === "state" ? 1 : 2); expect(io.propose).not.toHaveBeenCalled();
  });
  it("rejects malformed stored accepted version rather than repairing it to a guessed version", async () => {
    const f = database({ state: [{ accepted_version: "not-a-version" }] });
    await expect(createConversationPlanService(f.sql, { now }).inspect(scope, candidateId)).rejects.toMatchObject({ name: "ZodError" });
    expect(io.propose).not.toHaveBeenCalled();
  });
});
