import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCardRepository } from "./cards";
import { loadCard } from "./cards-ops";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { CardRepositoryError, mapCard } from "./cards-types";

vi.mock("./cards-ops", () => ({ loadCard: vi.fn(), assertWorkspaceOwner: vi.fn(),
  listCardQueue: vi.fn(), listWorkspaceCards: vi.fn(), writeState: vi.fn() }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn(), admitLearningSources: vi.fn() }));

const workspaceId = randomUUID(), ownerUserId = randomUUID(), cardId = randomUUID();
const row = { id: cardId, owner_user_id: ownerUserId, front: " raw front ", back: " raw back ",
  source_document_id: null, syllabus_point_id: null, tags: ["raw tag"], course_id: null, skill_label: null,
  archived: false, content_version: 7, paused_until: null, maintain_until: null, exclude_from_assessment: false,
  created_at: new Date("2026-01-01T00:00:00Z") };
const input = { workspaceId, cardId };
function fixture() {
  const order: string[] = [];
  let canonicalRows: unknown[] = [{ owner_user_id: ownerUserId }];
  let workspaceRows: unknown[] = [{ owner_user_id: ownerUserId }];
  let updateRows: unknown[] = [row];
  const query = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("UPDATE cards")) { order.push("update"); return updateRows; }
    order.push(text.includes("FOR SHARE") ? "workspace-share" : "canonical");
    return text.includes("FOR SHARE") ? workspaceRows : canonicalRows;
  });
  const begin = vi.fn(async (callback: (tx: Sql) => Promise<unknown>) => {
    order.push("begin");
    try { const result = await callback(sql); order.push("commit"); return result; }
    catch (error) { order.push("rollback"); throw error; }
  });
  const sql = Object.assign(query, { begin }) as unknown as Sql;
  vi.mocked(loadCard).mockImplementation(async () => { order.push("load"); return mapCard(row); });
  vi.mocked(lockWorkspaceLearningHistory).mockImplementation(async () => { order.push("history"); });
  return { sql, query, begin, order, repo: createCardRepository(sql),
    canonical: (rows: unknown[]) => { canonicalRows = rows; },
    workspace: (rows: unknown[]) => { workspaceRows = rows; },
    updated: (rows: unknown[]) => { updateRows = rows; } };
}
beforeEach(() => { vi.resetAllMocks(); });

describe("updateControls history boundary", () => {
  it("preserves the complete preflight, canonical key, history, SHARE, reread, update and returned mapping order", async () => {
    const f = fixture();
    await expect(f.repo.updateControls(input)).resolves.toEqual(mapCard(row));
    expect(f.order).toEqual(["load", "canonical", "begin", "history", "workspace-share", "load", "update", "commit"]);
    expect(lockWorkspaceLearningHistory).toHaveBeenCalledWith(f.sql, { workspaceId, ownerUserId });
    expect(loadCard).toHaveBeenNthCalledWith(1, f.sql, workspaceId, cardId);
    expect(loadCard).toHaveBeenNthCalledWith(2, f.sql, workspaceId, cardId);
  });

  it.each([new CardRepositoryError("NOT_FOUND", `Card not found: ${cardId}`),
    Object.assign(new Error("invalid UUID"), { code: "22P02" }), new Error("preflight mapping failed")])(
    "preserves preflight error identity and priority over controls/history: %s", async error => {
      const f = fixture(); vi.mocked(loadCard).mockRejectedValueOnce(error);
      await expect(f.repo.updateControls({ ...input, maintainUntil: "invalid" })).rejects.toBe(error);
      expect(f.query).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
      expect(lockWorkspaceLearningHistory).not.toHaveBeenCalled();
    });

  it("maps absent canonical workspace only after the original preflight", async () => {
    const f = fixture(); f.canonical([]);
    await expect(f.repo.updateControls(input)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
    expect(f.order).toEqual(["load", "canonical"]); expect(f.begin).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ owner_user_id: randomUUID() }] }])("rolls back locked workspace disappearance/drift: %j", async ({ rows }) => {
    const f = fixture(); f.workspace(rows);
    const work = f.repo.updateControls(input);
    await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
    expect(f.order.at(-1)).toBe("rollback"); expect(loadCard).toHaveBeenCalledTimes(1);
    expect(lockWorkspaceLearningHistory).toHaveBeenCalledTimes(1);
  });

  it.each([{ rows: [] }, { rows: [{ owner_user_id: randomUUID() }] }])("maps the helper's exact missing-owner error only after confirmation: %j", async ({ rows }) => {
    const f = fixture(); f.canonical(rows);
    // First lookup succeeds; the helper error's confirmation sees the changed candidate.
    f.query.mockResolvedValueOnce([{ owner_user_id: ownerUserId }]);
    vi.mocked(lockWorkspaceLearningHistory).mockRejectedValueOnce(Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" }));
    const work = f.repo.updateControls(input);
    await expect(work).rejects.toBeInstanceOf(CardRepositoryError);
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
    expect(f.order.at(-1)).toBe("rollback");
    expect(lockWorkspaceLearningHistory).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" }),
    Object.assign(new Error("other not found"), { code: "NOT_FOUND" }),
    Object.assign(new Error("invalid UUID"), { code: "22P02" }),
    Object.assign(new Error("lock unavailable"), { code: "55P03" }),
    Object.assign(new Error("serialization failure"), { code: "40001" }),
  ])("preserves helper error identity without retry when no candidate drift is proven: %s", async error => {
    const f = fixture(); vi.mocked(lockWorkspaceLearningHistory).mockRejectedValueOnce(error);
    await expect(f.repo.updateControls(input)).rejects.toBe(error);
    expect(lockWorkspaceLearningHistory).toHaveBeenCalledTimes(1);
    expect(f.order.at(-1)).toBe("rollback");
  });

  it("preserves reread error identity and rolls history back", async () => {
    const f = fixture(), error = new Error("reread mapping failed");
    vi.mocked(loadCard).mockResolvedValueOnce(mapCard(row)).mockRejectedValueOnce(error);
    await expect(f.repo.updateControls(input)).rejects.toBe(error);
    expect(f.order).not.toContain("update"); expect(f.order.at(-1)).toBe("rollback");
  });

  it("rejects a reread owner drift against the originally observed card", async () => {
    const f = fixture();
    vi.mocked(loadCard).mockResolvedValueOnce(mapCard(row)).mockResolvedValueOnce({ ...mapCard(row), ownerUserId: randomUUID() });
    await expect(f.repo.updateControls(input)).rejects.toBeInstanceOf(CardRepositoryError);
    expect(f.order).not.toContain("update"); expect(f.order.at(-1)).toBe("rollback");
  });

  it.each([{ rows: [] }, { rows: [{ ...row, owner_user_id: randomUUID() }] }])("rejects zero rows/returned owner drift and rolls back: %j", async ({ rows }) => {
    const f = fixture(); f.updated(rows);
    await expect(f.repo.updateControls(input)).rejects.toMatchObject({ code: "NOT_FOUND", message: `Card not found: ${cardId}` });
    expect(f.order.at(-1)).toBe("rollback");
  });

  it("does not pre-reject a static card/workspace owner mismatch before the SQL guard", async () => {
    const f = fixture(), canonicalOwner = randomUUID(), error = Object.assign(new Error("card owner must match workspace owner"), { code: "23000" });
    f.canonical([{ owner_user_id: canonicalOwner }]); f.workspace([{ owner_user_id: canonicalOwner }]);
    f.query.mockImplementationOnce(async () => [{ owner_user_id: canonicalOwner }])
      .mockImplementationOnce(async () => [{ owner_user_id: canonicalOwner }]).mockRejectedValueOnce(error);
    await expect(f.repo.updateControls(input)).rejects.toBe(error);
    expect(loadCard).toHaveBeenCalledTimes(2); expect(f.order.at(-1)).toBe("rollback");
  });

  it("rolls back returned mapping failure rather than claiming a successful control write", async () => {
    const f = fixture(); f.updated([{ ...row, archived: "not-boolean" }]);
    await expect(f.repo.updateControls(input)).rejects.toThrow();
    expect(f.order).toContain("update"); expect(f.order.at(-1)).toBe("rollback");
  });
});
