import {
  courselessActivityOutcomeSchema,
  writingCommandInputSchema,
  writingStartInputSchema,
  writingWorkspaceResponseSchema,
  writingWorkspaceViewSchema,
  type CourselessActivityOutcome,
  type WritingCommandInput,
  type WritingStartInput,
  type WritingWorkspaceResponse,
  type WritingWorkspaceView,
} from "@aistudy/contracts";

export class WritingWorkspaceApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "WritingWorkspaceApiError";
    this.code = code;
    this.status = status;
  }
}

export type WritingCommandResponse = {
  workspace: WritingWorkspaceView;
  outcome?: CourselessActivityOutcome;
};

type FetchImpl = typeof fetch;
type ErrorBody = { error?: { code?: string; message?: string } };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createWritingWorkspaceApi(fetchImpl: FetchImpl = fetch) {
  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const errorBody = body as ErrorBody | null;
      throw new WritingWorkspaceApiError(
        errorBody?.error?.code ?? "API_ERROR",
        errorBody?.error?.message ?? "写作区操作失败，请稍后重试。",
        response.status,
      );
    }
    return body;
  }

  return {
    async start(input: WritingStartInput): Promise<WritingWorkspaceView> {
      const parsed = writingStartInputSchema.parse(input);
      const body = await request("/api/opening/writing", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      return writingWorkspaceViewSchema.parse(body);
    },

    async get(
      documentId: string,
      options?: { focusBlockId?: string | null; activityId?: string | null },
    ): Promise<WritingWorkspaceResponse> {
      const params = new URLSearchParams();
      if (options?.focusBlockId) params.set("focusBlock", options.focusBlockId);
      if (options?.activityId) params.set("activity", options.activityId);
      const query = params.toString();
      const qs = query ? `?${query}` : "";
      const body = await request(
        `/api/opening/writing/${encodeURIComponent(documentId)}${qs}`,
        { method: "GET" },
      );
      return writingWorkspaceResponseSchema.parse(body);
    },

    async command(
      documentId: string,
      input: WritingCommandInput,
    ): Promise<WritingCommandResponse> {
      const parsed = writingCommandInputSchema.parse(input);
      const body = await request(
        `/api/opening/writing/${encodeURIComponent(documentId)}`,
        {
          method: "POST",
          body: JSON.stringify(parsed),
        },
      );
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const workspace = writingWorkspaceViewSchema.parse(record.workspace);
      const outcome = record.outcome !== undefined
        ? courselessActivityOutcomeSchema.parse(record.outcome)
        : undefined;
      return outcome ? { workspace, outcome } : { workspace };
    },
  };
}

export type WritingWorkspaceApi = ReturnType<typeof createWritingWorkspaceApi>;
