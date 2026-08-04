import {
  searchResponseSchema,
  type SearchHit,
} from "@aistudy/contracts";

export type SearchApi = {
  search(query: string, limit?: number): Promise<SearchHit[]>;
};

export class SearchApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SearchApiError";
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

export function createSearchApi(fetchImpl: FetchImpl = fetch): SearchApi {
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const errorBody = body as ErrorBody | null;
      throw new SearchApiError(
        errorBody?.error?.code ?? "REQUEST_FAILED",
        errorBody?.error?.message ?? "请求失败，请稍后重试。",
        response.status,
      );
    }
    return body;
  }

  return {
    async search(query, limit) {
      try {
        const params = new URLSearchParams({ q: query });
        if (limit !== undefined) params.set("limit", String(limit));
        const body = searchResponseSchema.parse(await request(
          `/api/search?${params.toString()}`,
          { method: "GET" },
        ));
        return body.hits;
      } catch (error) {
        if (error instanceof SearchApiError) throw error;
        throw new SearchApiError("INVALID_RESPONSE", "搜索响应格式无效。", 500);
      }
    },
  };
}
