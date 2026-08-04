import {
  documentTagsResponseSchema,
  documentTagsUpdateSchema,
} from "@aistudy/contracts";

export type DocumentTagsApi = {
  get(documentId: string): Promise<string[]>;
  set(documentId: string, tags: string[]): Promise<string[]>;
};

export class DocumentTagsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DocumentTagsApiError";
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

export function createDocumentTagsApi(fetchImpl: FetchImpl = fetch): DocumentTagsApi {
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const errorBody = body as ErrorBody | null;
      throw new DocumentTagsApiError(
        errorBody?.error?.code ?? "REQUEST_FAILED",
        errorBody?.error?.message ?? "请求失败，请稍后重试。",
        response.status,
      );
    }
    return body;
  }

  async function parseResponse(body: unknown): Promise<string[]> {
    try {
      return documentTagsResponseSchema.parse(body).tags;
    } catch {
      throw new DocumentTagsApiError("INVALID_RESPONSE", "标签响应格式无效。", 500);
    }
  }

  return {
    async get(documentId) {
      return parseResponse(await request(
        `/api/documents/${encodeURIComponent(documentId)}/tags`,
        { method: "GET" },
      ));
    },
    async set(documentId, tags) {
      const input = documentTagsUpdateSchema.parse({ tags });
      return parseResponse(await request(
        `/api/documents/${encodeURIComponent(documentId)}/tags`,
        { method: "PUT", body: JSON.stringify(input) },
      ));
    },
  };
}
