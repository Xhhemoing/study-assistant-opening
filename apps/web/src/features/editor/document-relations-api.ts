import {
  createDocumentRelationRequestSchema,
  managedRelationSchema,
  managedRelationsResponseSchema,
  updateDocumentRelationRequestSchema,
  type ManagedRelation,
  type RelationMutationTarget,
  type RelationType,
} from "@aistudy/contracts";

export type DocumentRelationsApi = {
  list(documentId: string): Promise<ManagedRelation[]>;
  create(documentId: string, to: RelationMutationTarget, relationType: RelationType): Promise<ManagedRelation>;
  update(documentId: string, relationId: string, relationType: RelationType): Promise<ManagedRelation>;
  remove(documentId: string, relationId: string): Promise<void>;
};

export class DocumentRelationsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DocumentRelationsApiError";
    this.code = code;
    this.status = status;
  }
}

type FetchImpl = typeof fetch;
type ErrorBody = { error?: { code?: string; message?: string } };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createDocumentRelationsApi(fetchImpl: FetchImpl = fetch): DocumentRelationsApi {
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const errorBody = body as ErrorBody | null;
      throw new DocumentRelationsApiError(
        errorBody?.error?.code ?? "REQUEST_FAILED",
        errorBody?.error?.message ?? "关系请求失败，请稍后重试。",
        response.status,
      );
    }
    return body;
  }

  function parseRelation(body: unknown): ManagedRelation {
    try {
      return managedRelationSchema.parse((body as { relation?: unknown } | null)?.relation);
    } catch {
      throw new DocumentRelationsApiError("INVALID_RESPONSE", "关系响应格式无效。", 500);
    }
  }

  function parseInput<T>(parse: () => T): T {
    try {
      return parse();
    } catch {
      throw new DocumentRelationsApiError("VALIDATION", "关系请求格式无效。", 400);
    }
  }

  return {
    async list(documentId) {
      try {
        const body = await request(`/api/documents/${encodeURIComponent(documentId)}/relations`, { method: "GET" });
        return managedRelationsResponseSchema.parse(body).relations;
      } catch (error) {
        if (error instanceof DocumentRelationsApiError) throw error;
        throw new DocumentRelationsApiError("INVALID_RESPONSE", "关系响应格式无效。", 500);
      }
    },
    async create(documentId, to, relationType) {
      const input = parseInput(() => createDocumentRelationRequestSchema.parse({ to, relationType }));
      return parseRelation(await request(
        `/api/documents/${encodeURIComponent(documentId)}/relations`,
        { method: "POST", body: JSON.stringify(input) },
      ));
    },
    async update(documentId, relationId, relationType) {
      const input = parseInput(() => updateDocumentRelationRequestSchema.parse({ relationType }));
      return parseRelation(await request(
        `/api/documents/${encodeURIComponent(documentId)}/relations/${encodeURIComponent(relationId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ));
    },
    async remove(documentId, relationId) {
      await request(
        `/api/documents/${encodeURIComponent(documentId)}/relations/${encodeURIComponent(relationId)}`,
        { method: "DELETE" },
      );
    },
  };
}
