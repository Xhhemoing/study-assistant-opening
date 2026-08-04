import {
  createExplorationBlockRequestSchema,
  createExplorationBranchRequestSchema,
  createExplorationRequestSchema,
  explorationBlockResponseSchema,
  explorationCreateResponseSchema,
  explorationDetailResponseSchema,
  explorationListResponseSchema,
  explorationStatusResponseSchema,
  explorationBranchResponseSchema,
  type CreateExplorationBlockRequest,
  type CreateExplorationBranchRequest,
  type CreateExplorationRequest,
  type ExplorationBlock,
  type ExplorationBranch,
  type PersistedExploration,
} from "@aistudy/contracts";

export class ExplorationApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ExplorationApiError";
  }
}

async function request<T>(url: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? (body as { error?: { code?: string; message?: string } }).error : undefined;
    throw new ExplorationApiError(response.status, error?.code ?? "UNKNOWN", error?.message ?? "探索请求失败");
  }
  return parse(body);
}

export const explorationApi = {
  list(): Promise<PersistedExploration[]> {
    return request("/api/explorations", { method: "GET" }, (body) => explorationListResponseSchema.parse(body).explorations);
  },
  create(input: CreateExplorationRequest): Promise<ExplorationApiCreateResult> {
    const parsed = createExplorationRequestSchema.parse(input);
    return request("/api/explorations", { method: "POST", body: JSON.stringify(parsed) }, (body) => explorationCreateResponseSchema.parse(body).exploration);
  },
  get(id: string): Promise<ExplorationDetailResponse> {
    return request(`/api/explorations/${id}`, { method: "GET" }, (body) => explorationDetailResponseSchema.parse(body));
  },
  createBranch(id: string, input: CreateExplorationBranchRequest): Promise<ExplorationBranch> {
    const parsed = createExplorationBranchRequestSchema.parse(input);
    return request(`/api/explorations/${id}/branches`, { method: "POST", body: JSON.stringify(parsed) }, (body) => explorationBranchResponseSchema.parse(body).branch);
  },
  createBlock(id: string, input: CreateExplorationBlockRequest): Promise<ExplorationBlock> {
    const parsed = createExplorationBlockRequestSchema.parse(input);
    return request(`/api/explorations/${id}/blocks`, { method: "POST", body: JSON.stringify(parsed) }, (body) => explorationBlockResponseSchema.parse(body).block);
  },
  setStatus(id: string, status: "open" | "closed"): Promise<PersistedExploration> {
    return request(`/api/explorations/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, (body) => explorationStatusResponseSchema.parse(body).exploration);
  },
};

export type ExplorationApiCreateResult = PersistedExploration & { rootBranch: ExplorationBranch };
export type ExplorationDetailResponse = ReturnType<typeof explorationDetailResponseSchema.parse>;
