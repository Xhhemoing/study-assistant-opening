import { connectionCredentialInputSchema, imapSetupInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import {
  connectionCredentialFingerprint, createOpeningConnectionsRepository, CredentialVaultError,
  encryptConnectionCredential, OpeningConnectionError,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";
import { createSyncDingTalkHandler } from "../../../../../worker/src/jobs/sync-dingtalk";

const clientKeySchema = z.string().min(8).max(200);
const keyInput = z.object({ clientKey: clientKeySchema }).strict();
const revokeInput = keyInput.extend({ expectedVersion: z.number().int().nonnegative() });
const dingtalkInput = keyInput.extend({ label: z.string().min(1).max(180), requestedScopes: z.array(z.string().min(1).max(200)).max(32) });
function mapped(error: unknown): never {
  if (error instanceof CredentialVaultError) throw new ApiError("CONFIGURATION", "连接凭据加密未配置或密钥不可用。", 503);
  if (error instanceof OpeningConnectionError) throw new ApiError(error.code, error.message, error.code === "NOT_FOUND" ? 404 : 409);
  throw error;
}
function assertAllowedHost(host: string) {
  // No sockets are opened here. C02 must also validate DNS/IP and TLS before connecting.
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes("..")) {
    throw new ApiError("VALIDATION", "IMAP 主机不能包含 URL、凭据或路径。", 400);
  }
  const allowed = (process.env.OPENING_IMAP_ALLOWED_HOSTS || "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host.toLowerCase())) throw new ApiError("VALIDATION", "IMAP 主机尚未由管理员授权。", 400);
}
export function createOpeningConnectionService(sql: Sql) {
  const repo = createOpeningConnectionsRepository(sql);
  return {
    list(scope: Scope) { return repo.list(scope); },
    async createImap(scope: Scope, raw: unknown) {
      const input = imapSetupInputSchema.parse(raw);
      assertAllowedHost(input.host);
      try { return await repo.createImap(scope, input); } catch (error) { return mapped(error); }
    },
    async createDingtalk(scope: Scope, raw: unknown) {
      const input = dingtalkInput.parse(raw);
      try { return await repo.createDingtalk(scope, input); } catch (error) { return mapped(error); }
    },
    async credential(scope: Scope, rawId: string, raw: unknown) {
      const id = uuidSchema.parse(rawId);
      const input = connectionCredentialInputSchema.extend({ secret: z.string().min(1).max(10000) }).parse(raw);
      try {
        await repo.get(scope, id);
        const encrypted = encryptConnectionCredential({ workspaceId: scope.workspaceId, connectionId: id, secret: input.secret });
        await repo.putCredential(scope, id, encrypted, input.clientKey, stored => {
          const [keyId] = JSON.parse(stored) as [string, string];
          return stored === connectionCredentialFingerprint({ workspaceId: scope.workspaceId, connectionId: id, secret: input.secret, keyId });
        });
      } catch (error) { return mapped(error); }
    },
    async revoke(scope: Scope, rawId: string, raw: unknown) {
      const id = uuidSchema.parse(rawId); const input = revokeInput.parse(raw);
      try { return await repo.revoke(scope, id, input.expectedVersion, input.clientKey); } catch (error) { return mapped(error); }
    },
    async checkUnavailable(scope: Scope, rawId: string, raw: unknown) {
      const id = uuidSchema.parse(rawId); keyInput.parse(raw);
      try {
        const connection = await repo.get(scope, id);
        if (connection.state === "revoked") throw new ApiError("CONFLICT", "连接已撤销。", 409);
      } catch (error) { return mapped(error); }
      throw new ApiError("CONFIGURATION", "连接状态检查尚未实现，未执行远程检查。", 503);
    },
    async unavailable(scope: Scope, rawId: string, raw: unknown) {
      const id = uuidSchema.parse(rawId); keyInput.parse(raw);
      let connection;
      try {
        connection = await repo.get(scope, id);
        if (connection.state === "revoked") throw new ApiError("CONFLICT", "连接已撤销。", 409);
      } catch (error) { return mapped(error); }
      if (connection.kind === "dingtalk") return createSyncDingTalkHandler(sql)({ connectionId: id });
      throw new ApiError("CONFIGURATION", "连接适配器尚未实现，未执行远程检查或同步。", 503);
    },
  };
}
