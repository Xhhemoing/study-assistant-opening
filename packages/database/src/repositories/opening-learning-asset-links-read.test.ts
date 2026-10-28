import { expect, it } from "vitest";
import { learningAssetOriginHref } from "./opening-learning-asset-links-read";
const id = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";
it("returns to an existing exact generic activity and preserves the block version", () => { expect(learningAssetOriginHref({ purpose: "learning_help", courseId, activityId: id, blockId: id, contentVersion: 2 }, {})).toBe(`/opening/courses/${courseId}/study?activity=${id}&block=${id}&contentVersion=2`); });
it("returns span lessons using the real lesson and retest identities", () => { expect(learningAssetOriginHref({ purpose: "learning_help", courseId, activityId: id }, { spanLesson: { retestId: courseId } })).toBe(`/opening/courses/${courseId}/study/span?lesson=${id}&retest=${courseId}`); });
it("does not invent an activity when an anchor only points to material", () => { expect(learningAssetOriginHref({ purpose: "material_read", sourceId: id, sourceVersion: 1 }, {})).toBeNull(); });
it("keeps the active original course return when only the associated target course is archived", async () => {
  const { readLearningAssetLinkView } = await import("./opening-learning-asset-links-read");
  const targetId = "33333333-3333-4333-8333-333333333333", scope = { workspaceId: id, ownerUserId: id };
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => { const query = strings.join("?"); if (query.includes("SELECT title,archived_at FROM courses")) return [{ title: "关联目标课B", archived_at: "2026-10-27T00:00:00Z" }]; if (query.includes("SELECT d.id FROM library_documents")) return [{ id }]; if (query.includes("SELECT course_id,content_version,checkpoint_json")) return [{ course_id: courseId, content_version: 2, checkpoint_json: {} }]; if (query.includes("SELECT archived_at FROM courses") && values.includes(courseId)) return [{ archived_at: null }]; return []; }) as unknown as import("postgres").Sql;
  const row = { id, asset_type: "document", asset_id: id, asset_version: null, course_id: targetId, goal_id: null, requirement_id: null, purpose: "reference", origin_json: { purpose: "learning_help", courseId, activityId: id }, source_refs: [], status: "active", revision: 1, created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" };
  const view = await readLearningAssetLinkView(db, scope, row);
  expect(view.originHref).toBe(`/opening/courses/${courseId}/study?activity=${id}`);
  expect(view.warnings).toContain("关联课程已归档，历史关联保留。");
});
