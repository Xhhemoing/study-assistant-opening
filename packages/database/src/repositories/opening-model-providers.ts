import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import {
  CredentialVaultError, decryptWorkspaceSecret, encryptWorkspaceSecret,
} from "../storage/opening-credential-vault";

export const OPENING_MODEL_PROVIDER_MAX = 8;
export const OPENING_MODEL_PROVIDER_MODEL_MAX = 16;
export const OPENING_MODEL_MERGED_MAX = 32;

export class OpeningModelProviderError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT" | "LIMIT", message: string) {
    super(message); this.name = "OpeningModelProviderError";
  }
}

export type OpeningProviderConfigView = {
  id: string; label: string; baseUrl: string;
  hasApiKey: boolean; apiKeyHint: string | null; apiKeyUpdatedAt: string | null;
  modelCount: number; createdAt: string; updatedAt: string;
};
export type OpeningProviderModelView = {
  id: string; providerId: string; label: string; modelName: string;
  inputCentsPerMillion: number; outputCentsPerMillion: number; supportsVision: boolean;
  createdAt: string; updatedAt: string;
};
export type OpeningResolvableModel = {
  id: string; providerId: string; providerLabel: string; label: string; modelName: string;
  baseUrl: string; apiKey: string; supportsVision: boolean;
  inputCentsPerMillion: number; outputCentsPerMillion: number;
  createdAt: string; vaultConfigBroken: boolean;
};

type Row = Record<string, unknown>;
type ProviderInput = { label: string; baseUrl: string; apiKey?: string | undefined };
type ProviderUpdate = {
  label?: string | undefined; baseUrl?: string | undefined; apiKey?: string | undefined;
};
type ModelInput = {
  label: string; modelName: string; inputCentsPerMillion: number;
  outputCentsPerMillion: number; supportsVision?: boolean | undefined;
};
type ModelUpdate = {
  label?: string | undefined; modelName?: string | undefined;
  inputCentsPerMillion?: number | undefined; outputCentsPerMillion?: number | undefined;
  supportsVision?: boolean | undefined;
};

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}
function providerView(row: Row, modelCount: number): OpeningProviderConfigView {
  return {
    id: String(row.provider_id), label: String(row.label), baseUrl: String(row.base_url),
    hasApiKey: row.key_id !== null,
    apiKeyHint: row.api_key_hint ? String(row.api_key_hint) : null,
    apiKeyUpdatedAt: row.credential_updated_at ? iso(row.credential_updated_at) : null,
    modelCount, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function modelView(row: Row): OpeningProviderModelView {
  return {
    id: String(row.id), providerId: String(row.provider_id), label: String(row.label),
    modelName: String(row.model_name),
    inputCentsPerMillion: Number(row.input_cents_per_million),
    outputCentsPerMillion: Number(row.output_cents_per_million),
    supportsVision: Boolean(row.supports_vision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function secretHint(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : "";
}
async function lockOwner(tx: TransactionSql, scope: Scope) {
  const rows = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!rows.length) throw new OpeningModelProviderError("NOT_FOUND", "workspace not found");
}
async function ownedProvider(tx: Sql | TransactionSql, scope: Scope, id: string) {
  const rows = await tx`SELECT p.* FROM opening_model_providers p JOIN workspaces w ON w.id=p.workspace_id
    WHERE p.id=${id} AND p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
      AND w.owner_user_id=${scope.ownerUserId}`;
  if (!rows.length) throw new OpeningModelProviderError("NOT_FOUND", "provider not found");
  return rows[0]!;
}
async function ownedModel(tx: Sql | TransactionSql, scope: Scope, id: string) {
  const rows = await tx`SELECT m.* FROM opening_model_provider_models m
    JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.id=${id} AND m.workspace_id=${scope.workspaceId} AND m.owner_user_id=${scope.ownerUserId}
      AND w.owner_user_id=${scope.ownerUserId}`;
  if (!rows.length) throw new OpeningModelProviderError("NOT_FOUND", "model not found");
  return rows[0]!;
}
async function countModels(tx: Sql | TransactionSql, providerId: string): Promise<number> {
  const rows = await tx`SELECT count(*)::int AS n FROM opening_model_provider_models WHERE provider_id=${providerId}`;
  return Number(rows[0]!.n);
}
export function createOpeningModelProvidersRepository(sql: Sql) {
  return {
    async list(scope: Scope) {
      const rows = await sql`SELECT p.id AS provider_id, p.label, p.base_url, p.created_at, p.updated_at,
          c.key_id, c.updated_at AS credential_updated_at, p.api_key_hint, 0 AS model_count
        FROM opening_model_providers p
        JOIN workspaces w ON w.id=p.workspace_id
        LEFT JOIN opening_model_provider_credentials c ON c.provider_id=p.id
        WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
          AND w.owner_user_id=${scope.ownerUserId}
        ORDER BY p.created_at, p.id`;
      return rows.map(row => providerView(row, Number(row.model_count)));
    },

    async createProvider(scope: Scope, input: ProviderInput) {
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const [existing] = await tx`SELECT id FROM opening_model_providers
          WHERE workspace_id=${scope.workspaceId} AND label=${input.label}`;
        if (existing) throw new OpeningModelProviderError("CONFLICT", "provider label already exists");
        const [count] = await tx`SELECT count(*)::int AS n FROM opening_model_providers
          WHERE workspace_id=${scope.workspaceId}`;
        if (Number(count!.n) >= OPENING_MODEL_PROVIDER_MAX) {
          throw new OpeningModelProviderError("LIMIT", `最多 ${OPENING_MODEL_PROVIDER_MAX} 个服务商`);
        }
        const id = randomUUID();
        await tx`INSERT INTO opening_model_providers
          (id,workspace_id,owner_user_id,label,base_url)
          VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.label},${input.baseUrl})`;
        if (input.apiKey) {
          const encrypted = encryptWorkspaceSecret({
            workspaceId: scope.workspaceId, providerId: id, secret: input.apiKey,
          });
          await tx`INSERT INTO opening_model_provider_credentials
            (provider_id,workspace_id,key_id,nonce,ciphertext,auth_tag)
            VALUES (${id},${scope.workspaceId},${encrypted.keyId},${encrypted.nonce},${encrypted.ciphertext},${encrypted.authTag})`;
          await tx`UPDATE opening_model_providers SET api_key_hint=${secretHint(input.apiKey)} WHERE id=${id}`;
        }
        const [fresh] = await tx`SELECT p.id AS provider_id, p.label, p.base_url, p.api_key_hint, p.created_at, p.updated_at,
            c.key_id, c.updated_at AS credential_updated_at
          FROM opening_model_providers p
          LEFT JOIN opening_model_provider_credentials c ON c.provider_id=p.id WHERE p.id=${id}`;
        return providerView(fresh!, 0);
      });
    },

    async updateProvider(scope: Scope, id: string, input: ProviderUpdate) {
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const provider = await ownedProvider(tx, scope, id);
        const label = input.label ?? String(provider.label);
        const baseUrl = input.baseUrl ?? String(provider.base_url);
        if (input.label !== undefined || input.baseUrl !== undefined) {
          const [clash] = await tx`SELECT id FROM opening_model_providers
            WHERE workspace_id=${scope.workspaceId} AND label=${label} AND id<>${id}`;
          if (clash) throw new OpeningModelProviderError("CONFLICT", "provider label already exists");
          await tx`UPDATE opening_model_providers SET label=${label},base_url=${baseUrl},updated_at=now()
            WHERE id=${id}`;
        }
        if (input.apiKey !== undefined) {
          const encrypted = encryptWorkspaceSecret({
            workspaceId: scope.workspaceId, providerId: id, secret: input.apiKey,
          });
          await tx`INSERT INTO opening_model_provider_credentials
            (provider_id,workspace_id,key_id,nonce,ciphertext,auth_tag)
            VALUES (${id},${scope.workspaceId},${encrypted.keyId},${encrypted.nonce},${encrypted.ciphertext},${encrypted.authTag})
            ON CONFLICT (provider_id) DO UPDATE SET key_id=EXCLUDED.key_id,nonce=EXCLUDED.nonce,
              ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,updated_at=now()`;
          await tx`UPDATE opening_model_providers SET api_key_hint=${secretHint(input.apiKey)},updated_at=now()
            WHERE id=${id}`;
        }
        const [fresh] = await tx`SELECT p.id AS provider_id, p.label, p.base_url, p.created_at, p.updated_at,
            c.key_id, c.updated_at AS credential_updated_at, p.api_key_hint
          FROM opening_model_providers p
          LEFT JOIN opening_model_provider_credentials c ON c.provider_id=p.id WHERE p.id=${id}`;
        return providerView(fresh!, await countModels(tx, id));
      });
    },

    async deleteProvider(scope: Scope, id: string) {
      await sql.begin(async tx => {
        await lockOwner(tx, scope);
        await ownedProvider(tx, scope, id);
        await tx`DELETE FROM opening_model_providers WHERE id=${id}`;
      });
    },

    async createModel(scope: Scope, providerId: string, input: ModelInput) {
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        await ownedProvider(tx, scope, providerId);
        const [clash] = await tx`SELECT id FROM opening_model_provider_models
          WHERE provider_id=${providerId} AND label=${input.label}`;
        if (clash) throw new OpeningModelProviderError("CONFLICT", "model label already exists");
        const providerCount = await countModels(tx, providerId);
        if (providerCount >= OPENING_MODEL_PROVIDER_MODEL_MAX) {
          throw new OpeningModelProviderError("LIMIT", `单个服务商最多 ${OPENING_MODEL_PROVIDER_MODEL_MAX} 个模型`);
        }
        const [total] = await tx`SELECT count(*)::int AS n
          FROM opening_model_provider_models WHERE workspace_id=${scope.workspaceId}`;
        if (Number(total!.n) >= OPENING_MODEL_MERGED_MAX) {
          throw new OpeningModelProviderError("LIMIT", `自定义模型总数最多 ${OPENING_MODEL_MERGED_MAX} 个`);
        }
        const [row] = await tx`INSERT INTO opening_model_provider_models
          (id,provider_id,workspace_id,owner_user_id,label,model_name,supports_vision,
           input_cents_per_million,output_cents_per_million)
          VALUES (${randomUUID()},${providerId},${scope.workspaceId},${scope.ownerUserId},${input.label},
            ${input.modelName},${input.supportsVision ?? false},${input.inputCentsPerMillion},${input.outputCentsPerMillion})
          RETURNING *`;
        return modelView(row!);
      });
    },

    async updateModel(scope: Scope, id: string, input: ModelUpdate) {
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        await ownedModel(tx, scope, id);
        const current = modelView((await tx`SELECT * FROM opening_model_provider_models WHERE id=${id}`)[0]!);
        const label = input.label ?? current.label;
        const [clash] = await tx`SELECT id FROM opening_model_provider_models
          WHERE provider_id=${current.providerId} AND label=${label} AND id<>${id}`;
        if (clash) throw new OpeningModelProviderError("CONFLICT", "model label already exists");
        const [row] = await tx`UPDATE opening_model_provider_models SET
            label=${label},model_name=${input.modelName ?? current.modelName},
            supports_vision=${input.supportsVision ?? current.supportsVision},
            input_cents_per_million=${input.inputCentsPerMillion ?? current.inputCentsPerMillion},
            output_cents_per_million=${input.outputCentsPerMillion ?? current.outputCentsPerMillion},
            updated_at=now()
          WHERE id=${id} RETURNING *`;
        return modelView(row!);
      });
    },

    async deleteModel(scope: Scope, id: string) {
      await sql.begin(async tx => {
        await lockOwner(tx, scope);
        await ownedModel(tx, scope, id);
        await tx`DELETE FROM opening_model_provider_models WHERE id=${id}`;
      });
    },

    async listModels(scope: Scope): Promise<OpeningProviderModelView[]> {
      const rows = await sql`SELECT m.* FROM opening_model_provider_models m
        JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.workspace_id=${scope.workspaceId} AND m.owner_user_id=${scope.ownerUserId}
          AND w.owner_user_id=${scope.ownerUserId}
        ORDER BY m.created_at, m.id`;
      return rows.map(modelView);
    },

    /**
     * Runtime view for model routing: includes the decrypted key in memory only.
     * A stored envelope that cannot be decrypted (missing/rotated vault key)
     * surfaces as `vaultConfigBroken` on the model instead of failing the list.
     */
    async listResolvableModels(scope: Scope): Promise<OpeningResolvableModel[]> {
      const rows = await sql`SELECT m.id, m.provider_id, m.label, m.model_name, m.supports_vision,
          m.input_cents_per_million, m.output_cents_per_million, m.created_at,
          p.label AS provider_label, p.base_url, p.owner_user_id,
          c.key_id, c.nonce, c.ciphertext, c.auth_tag
        FROM opening_model_provider_models m
        JOIN opening_model_providers p ON p.id=m.provider_id
        LEFT JOIN opening_model_provider_credentials c ON c.provider_id=p.id
        WHERE m.workspace_id=${scope.workspaceId} AND m.owner_user_id=${scope.ownerUserId}
        ORDER BY m.created_at, m.id`;
      const models: OpeningResolvableModel[] = [];
      for (const row of rows) {
        let apiKey = "";
        let vaultConfigBroken = false;
        if (row.key_id !== null) {
          try {
            apiKey = decryptWorkspaceSecret({
              workspaceId: scope.workspaceId, providerId: String(row.provider_id),
              keyId: String(row.key_id), nonce: row.nonce as Buffer,
              ciphertext: row.ciphertext as Buffer, authTag: row.auth_tag as Buffer,
            });
          } catch (error) {
            if (!(error instanceof CredentialVaultError)) throw error;
            vaultConfigBroken = true;
          }
        }
        models.push({
          id: String(row.id), providerId: String(row.provider_id),
          providerLabel: String(row.provider_label), label: String(row.label),
          modelName: String(row.model_name), baseUrl: String(row.base_url), apiKey,
          supportsVision: Boolean(row.supports_vision),
          inputCentsPerMillion: Number(row.input_cents_per_million),
          outputCentsPerMillion: Number(row.output_cents_per_million),
          createdAt: iso(row.created_at), vaultConfigBroken,
        });
      }
      return models;
    },
  };
}
