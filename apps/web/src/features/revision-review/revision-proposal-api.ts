import {
  createRevisionProposalRequestSchema,
  revisionProposalResponseSchema,
  revisionProposalReviewRequestSchema,
  revisionProposalReviewResponseSchema,
  revisionProposalResolveRequestSchema,
  revisionProposalsResponseSchema,
  type CreateRevisionProposalRequest,
  type ReviewRevisionProposalRequest,
  type ResolveRevisionProposalRequest,
} from "@aistudy/contracts";

export class RevisionProposalApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "RevisionProposalApiError";
    this.code = code;
    this.status = status;
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new RevisionProposalApiError(body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "提案请求失败，请稍后重试。", response.status);
  return body;
}

export function createRevisionProposalApi() {
  return {
    async list(documentId: string) {
      return revisionProposalsResponseSchema.parse(await call(`/api/documents/${encodeURIComponent(documentId)}/revision-proposals`)).proposals;
    },
    async create(documentId: string, input: CreateRevisionProposalRequest) {
      const parsed = createRevisionProposalRequestSchema.parse({ ...input, documentId });
      return revisionProposalResponseSchema.parse(await call(`/api/documents/${encodeURIComponent(documentId)}/revision-proposals`, { method: "POST", body: JSON.stringify(parsed) })).proposal;
    },
    async review(proposalId: string, input: ReviewRevisionProposalRequest) {
      const parsed = revisionProposalReviewRequestSchema.parse(input);
      return revisionProposalReviewResponseSchema.parse(await call(`/api/revision-proposals/${encodeURIComponent(proposalId)}/review`, { method: "POST", body: JSON.stringify(parsed) }));
    },
    async resolve(proposalId: string, input: ResolveRevisionProposalRequest) {
      const parsed = revisionProposalResolveRequestSchema.parse(input);
      return revisionProposalReviewResponseSchema.parse(await call(`/api/revision-proposals/${encodeURIComponent(proposalId)}/resolve`, { method: "POST", body: JSON.stringify(parsed) }));
    },
  };
}
export type RevisionProposalApi = ReturnType<typeof createRevisionProposalApi>;
