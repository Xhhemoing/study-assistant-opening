import { sourceActionResultSchema, sourceDeletionListSchema, sourceImpactSchema, type SourceActionInput } from "@aistudy/contracts";

export class SourceActionsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function createSourceActionsClient(fetcher: typeof fetch = fetch) {
  async function request(path: string, input?: SourceActionInput): Promise<unknown> {
    const response = await fetcher(`/api/opening/sources/${path}`, input ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    } : { cache: "no-store" });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (response.status === 409 && failure?.error?.message === "A stored image has unverifiable ownership; deletion requires repair") {
        throw new SourceActionsError(409, "部分衍生图片的归属无法确认，删除未执行。请联系管理员修复材料记录。");
      }
      throw new SourceActionsError(response.status, response.status === 409
        ? "材料或课程引用已变化，请重新查看影响后确认。"
        : response.status === 404 ? "材料或删除记录已不可用。" : "操作暂时未完成，请重试。");
    }
    return response.json();
  }
  return {
    impact: async (id: string) => sourceImpactSchema.parse(await request(`${encodeURIComponent(id)}/impact`)),
    act: async (id: string, input: SourceActionInput) => sourceActionResultSchema.parse(await request(`${encodeURIComponent(id)}/actions`, input)),
    deletions: async () => sourceDeletionListSchema.parse(await request("deletions")),
  };
}
export type SourceActionsClient = ReturnType<typeof createSourceActionsClient>;
