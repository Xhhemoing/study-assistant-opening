import {
  openingProviderInputSchema, openingProviderModelInputSchema, openingProviderModelUpdateSchema,
  openingProviderUpdateSchema, uuidSchema, type OpeningProviderConfigResponse,
} from "@aistudy/contracts";
import {
  createOpeningModelProvidersRepository, CredentialVaultError, OpeningModelProviderError,
} from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../auth/service";

function mapped(error: unknown): never {
  // Vault misconfiguration is a server problem; it must never surface as a client error.
  if (error instanceof CredentialVaultError) throw new ApiError("CONFIGURATION", "模型密钥加密未配置或密钥不可用。", 503);
  if (error instanceof OpeningModelProviderError) {
    throw new ApiError(
      error.code === "NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
      error.message,
      error.code === "NOT_FOUND" ? 404 : 409,
    );
  }
  throw error;
}

function parseOrUnprocessable(schema: z.ZodTypeAny, raw: unknown, message: string) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError("VALIDATION", message, 422);
  return parsed.data as never;
}

export function createProviderConfigService(sql: Sql) {
  const repo = createOpeningModelProvidersRepository(sql);
  return {
    async overview(scope: Scope): Promise<OpeningProviderConfigResponse> {
      const [providers, models] = await Promise.all([repo.list(scope), repo.listModels(scope)]);
      return { providers, models };
    },
    async createProvider(scope: Scope, raw: unknown) {
      const input = parseOrUnprocessable(openingProviderInputSchema, raw, "服务商配置格式无效。");
      try { return await repo.createProvider(scope, input); } catch (error) { return mapped(error); }
    },
    async updateProvider(scope: Scope, rawId: string, raw: unknown) {
      const id = parseOrUnprocessable(uuidSchema, rawId, "服务商不存在。");
      const input = parseOrUnprocessable(openingProviderUpdateSchema, raw, "服务商更新内容无效。");
      try { return await repo.updateProvider(scope, id, input); } catch (error) { return mapped(error); }
    },
    async deleteProvider(scope: Scope, rawId: string) {
      const id = parseOrUnprocessable(uuidSchema, rawId, "服务商不存在。");
      try { return await repo.deleteProvider(scope, id); } catch (error) { return mapped(error); }
    },
    async createModel(scope: Scope, rawProviderId: string, raw: unknown) {
      const providerId = parseOrUnprocessable(uuidSchema, rawProviderId, "服务商不存在。");
      const input = parseOrUnprocessable(openingProviderModelInputSchema, raw, "模型配置格式无效。");
      try { return await repo.createModel(scope, providerId, input); } catch (error) { return mapped(error); }
    },
    async updateModel(scope: Scope, rawModelId: string, raw: unknown) {
      const id = parseOrUnprocessable(uuidSchema, rawModelId, "模型不存在。");
      const input = parseOrUnprocessable(openingProviderModelUpdateSchema, raw, "模型更新内容无效。");
      try { return await repo.updateModel(scope, id, input); } catch (error) { return mapped(error); }
    },
    async deleteModel(scope: Scope, rawModelId: string) {
      const id = parseOrUnprocessable(uuidSchema, rawModelId, "模型不存在。");
      try { return await repo.deleteModel(scope, id); } catch (error) { return mapped(error); }
    },
  };
}
