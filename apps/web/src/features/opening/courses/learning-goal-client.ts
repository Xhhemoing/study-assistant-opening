import { learningGoalCreateSchema, learningGoalListSchema, learningGoalSchema, learningGoalSelectSchema, learningGoalUpdateSchema, type LearningGoalCreate, type LearningGoalUpdate } from "@aistudy/contracts";
import { z } from "zod";
import { createSessionFetch } from "../../auth/session-expiry";

export class LearningGoalRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function createLearningGoalClient(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const fetcher = createSessionFetch(transport);
  async function request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: unknown): Promise<T> {
    const response = await fetcher(path, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      const messageSchema = z.object({ message: z.string().max(1000) });
      const error = z.union([messageSchema, z.object({ error: messageSchema }).transform(value => value.error)]).safeParse(await response.json().catch(() => null));
      throw new LearningGoalRequestError(error.success ? error.data.message : "目标操作未完成，请重新核对。", response.status);
    }
    return schema.parse(await response.json());
  }
  return {
    list: (courseId?: string) => request(`/api/opening/learning-goals${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`, learningGoalListSchema),
    create: async (input: LearningGoalCreate) => request("/api/opening/learning-goals", learningGoalSchema, "POST", learningGoalCreateSchema.parse(input)),
    update: async (id: string, input: LearningGoalUpdate) => request(`/api/opening/learning-goals/${encodeURIComponent(id)}`, learningGoalSchema, "PATCH", learningGoalUpdateSchema.parse(input)),
    select: async (input: z.infer<typeof learningGoalSelectSchema>) => request("/api/opening/learning-goals/select", learningGoalListSchema, "POST", learningGoalSelectSchema.parse(input)),
    async courses() {
      const result = await request("/api/courses?includeArchived=true", z.object({ courses: z.array(z.object({ id: z.string().uuid(), title: z.string(), archivedAt: z.string().nullable().optional() })) }));
      return result.courses;
    },
  };
}
export type LearningGoalClient = ReturnType<typeof createLearningGoalClient>;
