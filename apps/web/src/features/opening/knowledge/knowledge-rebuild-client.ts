import { knowledgeSnapshotSchema, uuidSchema } from "@aistudy/contracts";
import { z } from "zod";
import { createSessionFetch } from "../../auth/session-expiry";
import { parseOpeningResponse } from "../client/parse-response";

const knowledgeRecordSchema = z.object({
  version: z.number().int().nonnegative(),
  snapshot: knowledgeSnapshotSchema,
  sourceVersions: z.record(z.string(), z.number().int().nonnegative()),
});
const rebuildReceiptSchema = z.object({
  jobId: uuidSchema,
  kind: z.literal("build-course-knowledge"),
  created: z.boolean(),
});
const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

export type CourseKnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;
export type KnowledgeRebuildReceipt = z.infer<typeof rebuildReceiptSchema>;

export class KnowledgeRebuildRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "KnowledgeRebuildRequestError";
  }
}

export function createKnowledgeRebuildClient(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const fetchImpl = createSessionFetch(transport);
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(path, { ...init, cache: "no-store", headers: { "content-type": "application/json" } });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = errorBodySchema.safeParse(body);
      throw new KnowledgeRebuildRequestError(response.status, error.success ? error.data.error.message : `request failed (${response.status})`);
    }
    return body;
  }
  const knowledgePath = (courseId: string) => `/api/opening/courses/${encodeURIComponent(courseId)}/knowledge`;
  return {
    async read(courseId: string, signal?: AbortSignal): Promise<CourseKnowledgeRecord> {
      return parseOpeningResponse(knowledgeRecordSchema, await request(knowledgePath(courseId), { method: "GET", signal }));
    },
    async rebuild(courseId: string, clientKey: string): Promise<KnowledgeRebuildReceipt> {
      return parseOpeningResponse(rebuildReceiptSchema, await request(`${knowledgePath(courseId)}/rebuild`, { method: "POST", body: JSON.stringify({ clientKey }) }));
    },
  };
}

export type KnowledgeRebuildClient = ReturnType<typeof createKnowledgeRebuildClient>;
