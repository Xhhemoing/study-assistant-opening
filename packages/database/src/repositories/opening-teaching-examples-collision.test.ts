import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";
vi.mock("./opening-course-ready-sources", () => ({ createOpeningCourseReadySourcesRepository: () => ({ assertMaterialPurposePin: async () => {} }) }));
vi.mock("./opening-learning-facts", () => ({
  learningError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  learningIso: (value: Date) => value.toISOString(), lockWorkspaceLearningHistory: async () => {}, lockLearningOwner: async () => {},
}));
vi.mock("./opening-course-route-origin", () => ({ assertOpeningCourseRouteCurrent: async () => {} }));
const saved = vi.hoisted(() => ({ blocks: [] as unknown[] }));
vi.mock("./library", () => ({ createLibraryRepository: () => ({ updateDocumentInTx: async (_tx: unknown, input: { blocks: unknown[] }) => { saved.blocks = input.blocks; } }) }));
vi.mock("./opening-ai-grading-ledger", () => ({ readOpeningAiGradingLedger: async () => "unsent" }));
import { createOpeningTeachingExamplesRepository, teachingExampleJobPayloadSchema } from "./opening-teaching-examples";

it("refuses exact saved prompt before any publication write (SQL double, not PG)", async () => {
  const id = "11111111-1111-4111-8111-111111111111", promptId = "22222222-2222-4222-8222-222222222222";
  const target = { activityId: id, documentId: id, revisionNumber: 1, contentVersion: 1, blockId: id };
  const prompt = "求 $\\int x^3 dx$。";
  const blocks = [{ id, type: "example", content: { text: "求 $\\int x^2 dx$。得 $x^3/3+C$。" } },
    { id: promptId, type: "prompt", content: { text: prompt } }];
  const order = [{ blockId: id, position: 0, role: "example", blockType: "example" },
    { blockId: promptId, position: 1, role: "prompt", blockType: "prompt" }];
  const refs = [{ sourceId: id, version: 1 }];
  const payload = teachingExampleJobPayloadSchema.parse({ mode: "example", request: { target, clientKey: "independent-overlap", consentVersion: "teaching-example-paid-v1", acceptPaidGeneration: true },
    originalExample: blocks[0].content.text, blocks, blockOrder: order, sourceRefs: refs, activitySourceIds: [id],
    purposePin: { courseId: id, materialUse: "teaching", sources: [] }, estimatedCents: 1 });
  const queries: string[] = [];
  const sql = Object.assign(async (parts: TemplateStringsArray) => {
    const q = parts.join("?"); queries.push(q);
    if (q.startsWith("FOR UPDATE OF") || q.startsWith("FOR SHARE OF")) return [];
    if (q.includes("SELECT id FROM users") || q.includes("SELECT s.id FROM opening_sources")) return [{ id }];
    if (q.includes("SELECT payload FROM opening_jobs")) return [{ payload }];
    if (q.includes("SELECT s.*,r.blocks")) return [{ id, teaching_unit_id: id, blocks, block_order: order, source_refs: refs,
      source_ids: [id], content_version: 1, version: 1, revision_number: 1, current_revision_number: 1, status: "active", generate_status: "idle", course_id: id }];
    if (q.includes("UPDATE opening_teaching_activities")) return [{ id }];
    if (q.includes("UPDATE opening_teaching_activity_specs") || q.includes("UPDATE opening_teaching_units")) return [];
    if (q.includes("SELECT * FROM opening_jobs")) return [{ payload, state: "running", created_at: new Date("2026-11-10T15:00:00Z") }];
    if (q.includes("SELECT revision_number,blocks")) return [{ revision_number: 2, blocks: saved.blocks }];
    throw new Error("unhandled SQL double: " + q);
  }, { begin: async (fn: (tx: unknown) => unknown) => fn(sql), json: (v: unknown) => v });
  const repository = createOpeningTeachingExamplesRepository(sql as unknown as Sql);
  const published = repository.publish({ workspaceId: id, ownerUserId: id, jobExecution: { id, token: "synthetic", privacyEpoch: 0 } }, id, payload,
    { problem: prompt, workedSolution: "幂次加一后除以4，得 $x^4/4+C$，求导核对。" });
  await expect(published).rejects.toThrow("当前练习题");
  expect(saved.blocks).toHaveLength(0);
  expect(queries.some(query => query.includes("UPDATE opening_teaching_"))).toBe(false);
});
