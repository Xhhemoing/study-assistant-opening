import {
  documentPropertiesResponseSchema,
  type DocumentPropertiesResponse,
} from "@aistudy/contracts";

export type DocumentPropertiesApi = {
  get(documentId: string): Promise<DocumentPropertiesResponse>;
};

export class DocumentPropertiesApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DocumentPropertiesApiError";
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

export function createDocumentPropertiesApi(fetchImpl: FetchImpl = fetch): DocumentPropertiesApi {
  return {
    async get(documentId) {
      const response = await fetchImpl(`/api/documents/${encodeURIComponent(documentId)}/properties`, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      const body = await readJson(response);
      if (!response.ok) {
        const errorBody = body as ErrorBody | null;
        throw new DocumentPropertiesApiError(
          errorBody?.error?.code ?? "REQUEST_FAILED",
          errorBody?.error?.message ?? "属性暂时无法读取。",
          response.status,
        );
      }
      try {
        return documentPropertiesResponseSchema.parse(body);
      } catch {
        throw new DocumentPropertiesApiError("INVALID_RESPONSE", "属性响应格式无效。", 500);
      }
    },
  };
}
