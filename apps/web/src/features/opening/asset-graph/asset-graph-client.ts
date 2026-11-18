import {
  assetGraphErrorResponseSchema,
  assetGraphPageSchema,
  assetGraphQuerySchema,
  normalizeAssetGraphQueryValue,
  type AssetGraphErrorCode,
  type AssetGraphPage,
  type AssetGraphQuery,
} from "@aistudy/contracts";
import { createSessionFetch } from "../../auth/session-expiry";

export type AssetGraphClientErrorCode =
  | AssetGraphErrorCode
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "SYNTHETIC_UNCOVERED";

export class AssetGraphRequestError extends Error {
  readonly code: AssetGraphClientErrorCode;
  readonly status?: number;

  constructor(code: AssetGraphClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AssetGraphRequestError";
    this.code = code;
    this.status = status;
  }
}

export type AssetGraphTransport = (
  query: AssetGraphQuery,
  signal?: AbortSignal,
) => Promise<AssetGraphPage>;

export type SyntheticAssetGraphFixtureCase = {
  name?: string;
  request: { body: unknown };
  http: number;
  response: unknown;
};

export type SyntheticAssetGraphFixtures = {
  cases: readonly SyntheticAssetGraphFixtureCase[];
};

export type AssetGraphRootsInput = Omit<Extract<AssetGraphQuery, { op: "roots" }>, "op">;
export type AssetGraphNeighborsInput = Omit<Extract<AssetGraphQuery, { op: "neighbors" }>, "op">;
export type AssetGraphDetailInput = Omit<Extract<AssetGraphQuery, { op: "detail" }>, "op">;

function cleanQueryObject(query: AssetGraphQuery): AssetGraphQuery {
  return normalizeAssetGraphQueryValue(query) as AssetGraphQuery;
}

function defaultHttpErrorForStatus(status: number): {
  code: AssetGraphClientErrorCode;
  message: string;
} {
  if (status === 400) {
    return { code: "VALIDATION", message: "查询参数格式不正确，请调整筛选条件后再试。" };
  }
  if (status === 401) {
    return { code: "UNAUTHENTICATED", message: "登录状态已失效，请先重新登录原账户。" };
  }
  if (status === 403) {
    return { code: "FORBIDDEN", message: "当前账户无法查看该知识地图范围。" };
  }
  if (status === 404) {
    return { code: "NOT_FOUND", message: "所选内容不可用或不在当前范围。" };
  }
  if (status === 409) {
    return { code: "CURSOR_STALE", message: "当前列表已更新，请从第 1 页重新读取。" };
  }
  return { code: "NETWORK", message: "知识地图服务暂时不可用，请稍后重试。" };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Create a deterministic synthetic transport backed by design fixture cases.
 * Matching is canonicalized recursively and is insensitive to object key ordering.
 */
export function createSyntheticAssetGraphTransport(
  fixtures: SyntheticAssetGraphFixtures,
): AssetGraphTransport {
  const index = new Map<string, SyntheticAssetGraphFixtureCase>();
  for (const item of fixtures.cases) {
    const key = JSON.stringify(normalizeAssetGraphQueryValue(item.request.body));
    index.set(key, item);
  }

  return async (query, signal) => {
    throwIfAborted(signal);
    const parsedQuery = assetGraphQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      throw new AssetGraphRequestError("VALIDATION", "查询参数格式不正确，请调整筛选条件后再试。", 400);
    }
    const key = JSON.stringify(normalizeAssetGraphQueryValue(parsedQuery.data));
    const matched = index.get(key);
    if (!matched) {
      throw new AssetGraphRequestError("SYNTHETIC_UNCOVERED", "设计样例未覆盖此请求");
    }

    if (matched.http >= 400) {
      const parsedError = assetGraphErrorResponseSchema.safeParse(matched.response);
      if (parsedError.success) {
        throw new AssetGraphRequestError(
          parsedError.data.error.code,
          parsedError.data.error.message,
          matched.http,
        );
      }
      const fallback = defaultHttpErrorForStatus(matched.http);
      throw new AssetGraphRequestError(fallback.code, fallback.message, matched.http);
    }

    try {
      return assetGraphPageSchema.parse(matched.response);
    } catch {
      throw new AssetGraphRequestError(
        "INVALID_RESPONSE",
        "样例响应格式异常，未能读取知识地图。",
        matched.http,
      );
    }
  };
}

/**
 * Create a same-origin HTTP transport targeting the supplied asset graph query endpoint.
 * Never falls back to synthetic fixtures when a request fails.
 */
export function createHttpAssetGraphTransport(
  endpoint: string,
  transportFetch: typeof fetch = (input, init) => fetch(input, init),
): AssetGraphTransport {
  const trimmedEndpoint = endpoint.trim();
  if (!trimmedEndpoint) {
    throw new Error("Asset graph endpoint must be a non-empty string.");
  }
  const fetcher = createSessionFetch(transportFetch);

  return async (query, signal) => {
    throwIfAborted(signal);
    const parsedQuery = assetGraphQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      throw new AssetGraphRequestError("VALIDATION", "查询参数格式不正确，请调整筛选条件后再试。", 400);
    }
    const canonicalBody = cleanQueryObject(parsedQuery.data);

    let response: Response;
    try {
      response = await fetcher(trimmedEndpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(canonicalBody),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new AssetGraphRequestError("NETWORK", "网络连接异常，请稍后重试。");
    }

    if (!response.ok) {
      const rawBody: unknown = await response.json().catch(() => null);
      const parsedError = assetGraphErrorResponseSchema.safeParse(rawBody);
      if (parsedError.success) {
        throw new AssetGraphRequestError(
          parsedError.data.error.code,
          parsedError.data.error.message,
          response.status,
        );
      }
      const fallback = defaultHttpErrorForStatus(response.status);
      throw new AssetGraphRequestError(fallback.code, fallback.message, response.status);
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      throw new AssetGraphRequestError(
        "INVALID_RESPONSE",
        "返回数据格式异常，未能读取知识地图。",
        response.status,
      );
    }

    const parsedPage = assetGraphPageSchema.safeParse(rawJson);
    if (!parsedPage.success) {
      throw new AssetGraphRequestError(
        "INVALID_RESPONSE",
        "返回数据格式异常，未能读取知识地图。",
        response.status,
      );
    }

    return parsedPage.data;
  };
}

export function createAssetGraphClient(transport: AssetGraphTransport) {
  async function query(input: AssetGraphQuery, signal?: AbortSignal): Promise<AssetGraphPage> {
    const parsed = assetGraphQuerySchema.safeParse(input);
    if (!parsed.success) {
      throw new AssetGraphRequestError("VALIDATION", "查询参数格式不正确，请调整筛选条件后再试。", 400);
    }
    return transport(cleanQueryObject(parsed.data), signal);
  }

  return {
    query,
    roots(input: AssetGraphRootsInput, signal?: AbortSignal) {
      return query({ op: "roots", ...input }, signal);
    },
    neighbors(input: AssetGraphNeighborsInput, signal?: AbortSignal) {
      return query({ op: "neighbors", ...input }, signal);
    },
    detail(input: AssetGraphDetailInput, signal?: AbortSignal) {
      return query({ op: "detail", ...input }, signal);
    },
  };
}

export type AssetGraphClient = ReturnType<typeof createAssetGraphClient>;
