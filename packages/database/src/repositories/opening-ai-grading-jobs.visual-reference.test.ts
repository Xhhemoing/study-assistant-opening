import { beforeEach, expect, it, vi } from "vitest";
import { readOpeningAttemptGradingUsesVision } from "./opening-ai-grading-jobs";
const mocks = vi.hoisted(() => ({ question: vi.fn(), chunks: vi.fn() }));
vi.mock("./opening-teaching-question", () => ({ readTeachingQuestionForGrading: mocks.question }));
vi.mock("./opening-grading-visual-references", () => ({ readOpeningPinnedTeachingChunks: mocks.chunks }));
const scope = { workspaceId: "w", ownerUserId: "u" };
const ref = { sourceId: "s", version: 2, chunkId: "pinned-chunk", page: 4 };
const sql = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); sql.mockResolvedValue([{ id: "v", attempt_source_ids: ["s"], attempt_source_versions: { s: 2 } }]);
  mocks.question.mockResolvedValue({ sourceRefs: [ref] });
});
it("uses the identical pinned chunk resolver, not all visual course materials", async () => {
  mocks.chunks.mockResolvedValue([{ image_object_key: "owned/page", page: 4 }]);
  await expect(readOpeningAttemptGradingUsesVision(sql as never, scope, "a")).resolves.toBe(true);
  expect(mocks.chunks).toHaveBeenCalledWith(sql, scope, [ref], { s: 2 });
  mocks.chunks.mockResolvedValue([{ image_object_key: null, page: 4 }]);
  await expect(readOpeningAttemptGradingUsesVision(sql as never, scope, "a")).resolves.toBe(false);
});
it("marks a missing immutable chunk unavailable rather than text, but rejects a foreign attempt", async () => {
  const conflict = Object.assign(new Error("pinned chunk missing"), { code: "CONFLICT" });
  mocks.chunks.mockRejectedValue(conflict);
  await expect(readOpeningAttemptGradingUsesVision(sql as never, scope, "a")).resolves.toBeNull();
  sql.mockResolvedValue([]);
  await expect(readOpeningAttemptGradingUsesVision(sql as never, scope, "foreign")).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("does not disguise infrastructure failures as an unavailable material", async () => {
  const failure = Object.assign(new Error("connection closed"), { code: "08006" });
  mocks.chunks.mockRejectedValue(failure);
  await expect(readOpeningAttemptGradingUsesVision(sql as never, scope, "a")).rejects.toBe(failure);
});
