import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { loadOpeningEmbeddingConfig } from "@aistudy/config";
import { createOpeningSourceEmbeddingsRepository } from "@aistudy/database";

export async function requestOpeningSourceIndex(sql: Sql, scope: Scope, sourceId: string): Promise<{ jobId: string }> {
  if (!loadOpeningEmbeddingConfig()) throw Object.assign(new Error("请先配置资料检索模型，再更新材料搜索。"), { code: "CONFLICT" });
  return createOpeningSourceEmbeddingsRepository(sql).reindex(scope, sourceId);
}
