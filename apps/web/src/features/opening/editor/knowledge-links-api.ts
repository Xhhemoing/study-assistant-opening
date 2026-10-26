import {
  indexDocumentLinksRequestSchema,
  knowledgeLinksResponseSchema,
  type KnowledgeLink,
} from "@aistudy/contracts";

export type KnowledgeLinksApi = {
  list(documentId: string): Promise<KnowledgeLink[]>;
  index(documentId: string, targetTitles: string[]): Promise<void>;
};

export class KnowledgeLinksApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "KnowledgeLinksApiError";
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

export function createKnowledgeLinksApi(fetchImpl: FetchImpl = fetch): KnowledgeLinksApi {
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const errorBody = body as ErrorBody | null;
      throw new KnowledgeLinksApiError(
        errorBody?.error?.code ?? "REQUEST_FAILED",
        errorBody?.error?.message ?? "请求失败，请稍后重试。",
        response.status,
      );
    }
    return body;
  }

  return {
    async list(documentId) {
      try {
        const body = knowledgeLinksResponseSchema.parse(await request(
          `/api/documents/${encodeURIComponent(documentId)}/links`,
          { method: "GET" },
        ));
        return body.links;
      } catch (error) {
        if (error instanceof KnowledgeLinksApiError) throw error;
        throw new KnowledgeLinksApiError("INVALID_RESPONSE", "链接响应格式无效。", 500);
      }
    },
    async index(documentId, targetTitles) {
      const input = indexDocumentLinksRequestSchema.parse({ targetTitles });
      await request(
        `/api/documents/${encodeURIComponent(documentId)}/links`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
  };
}
