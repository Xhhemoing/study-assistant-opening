import { z } from "zod";
import { learningAssetIdentitySchema, learningAssetLinkCreateSchema, learningAssetLinkDetachSchema, learningAssetLinkListSchema, learningAssetLinkViewSchema, studyNoteCreateSchema, studyNoteCreateResultSchema, type LearningAssetLinkCreate, type StudyNoteCreate } from "@aistudy/contracts";
import { createSessionFetch } from "../../auth/session-expiry";
export class LearningAssetLinkRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function safeLearningLinkHref(href: string) { if (!href.startsWith("/opening/") || /[\\\s]/.test(href)) throw new Error("关联位置无法验证，请从课程或资料列表重新打开。"); return href; }
export function createLearningAssetLinkClient(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const fetcher = createSessionFetch(transport);
  async function request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: unknown) { const response = await fetcher(path, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }); if (!response.ok) { const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(await response.json().catch(() => null)); throw new LearningAssetLinkRequestError(error.success ? error.data.error.message : "笔记关联操作未完成，请保留本页并重新确认这次操作。", response.status); } return schema.parse(await response.json()); }
  function view<T extends z.infer<typeof learningAssetLinkViewSchema>>(value: T) { if (value.originHref) safeLearningLinkHref(value.originHref); value.sourceHrefs.forEach(ref => safeLearningLinkHref(ref.href)); return value; }
  return {
    async list(input: z.infer<typeof learningAssetIdentitySchema>) { const selected = learningAssetIdentitySchema.parse(input); const result = await request(`/api/opening/learning-asset-links?${new URLSearchParams(selected)}`, learningAssetLinkListSchema); result.links.forEach(view); return result; },
    async create(input: LearningAssetLinkCreate) { return view(await request("/api/opening/learning-asset-links", learningAssetLinkViewSchema, "POST", learningAssetLinkCreateSchema.parse(input))); },
    async detach(input: z.infer<typeof learningAssetLinkDetachSchema>) { return view(await request("/api/opening/learning-asset-links", learningAssetLinkViewSchema, "PATCH", learningAssetLinkDetachSchema.parse(input))); },
    async note(input: StudyNoteCreate) { const result = await request("/api/opening/study-notes", studyNoteCreateResultSchema, "POST", studyNoteCreateSchema.parse(input)); view(result.link); return result; },
  };
}
export type LearningAssetLinkClient = ReturnType<typeof createLearningAssetLinkClient>;
