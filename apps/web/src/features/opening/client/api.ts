import {
  conversationCreateInputSchema,
  conversationResumeSchema,
  conversationSummarySchema,
  isoDateTimeSchema,
  jobStatusSchema,
  sourceRecordSchema,
  turnInputSchema,
  turnRecordSchema,
  uploadInputSchema,
  uploadTicketSchema,
  uuidSchema,
  type ConversationCreateInput,
  type ConversationResume,
  type ConversationSummary,
  type JobStatus,
  type SourceRecord,
  type TurnInput,
  type TurnRecord,
  type UploadInput,
  type UploadTicket,
} from "@aistudy/contracts";
import { z } from "zod";

export class OpeningApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "OpeningApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchLike = typeof fetch;

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function readError(body: unknown): { message: string; code: string | null } {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object"
  ) {
    const err = body.error as { message?: unknown; code?: unknown };
    const message =
      typeof err.message === "string" ? err.message : "request failed";
    const code = typeof err.code === "string" ? err.code : null;
    return { message, code };
  }
  return { message: "request failed", code: null };
}

async function request(
  path: string,
  init: RequestInit | undefined,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await fetchImpl(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await parseJson(res);
  if (!res.ok) {
    const { message, code } = readError(body);
    throw new OpeningApiError(
      res.status,
      message === "request failed" ? `request failed (${res.status})` : message,
      code,
    );
  }
  return body;
}

const summaryListSchema = z.array(conversationSummarySchema);
const turnListSchema = z.array(turnRecordSchema);
const sourceListSchema = z.array(sourceRecordSchema);

const jobStatusResponseSchema = z
  .object({
    id: uuidSchema,
    status: jobStatusSchema,
    error: z.object({ message: z.string().min(1) }).strict().nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type JobStatusResponse = {
  id: string;
  status: JobStatus;
  error: { message: string } | null;
  updatedAt: string;
};

/** Local opening staging PUT path (T03 sources HTTP). */
export function stagingPutUrl(sourceId: string): string {
  return `/api/opening/sources/${sourceId}/staging`;
}

export function resolveUploadPutUrl(ticket: UploadTicket): string {
  // Materials beginUpload returns absolute .../sources/:id/staging (or stub placeholders).
  if (
    ticket.uploadUrl.includes("upload.local") ||
    ticket.uploadUrl.includes("__SOURCE_ID__")
  ) {
    return stagingPutUrl(ticket.source.id);
  }
  return ticket.uploadUrl;
}

export function createOpeningApi(fetchImpl: FetchLike = fetch) {
  return {
    async listConversations(): Promise<ConversationSummary[]> {
      const body = await request("/api/opening/conversations", { method: "GET" }, fetchImpl);
      return summaryListSchema.parse(body);
    },

    async createConversation(
      input: ConversationCreateInput,
    ): Promise<{ id: string; title: string; courseId: string | null }> {
      const payload = conversationCreateInputSchema.parse(input);
      const body = await request(
        "/api/opening/conversations",
        { method: "POST", body: JSON.stringify(payload) },
        fetchImpl,
      );
      return z
        .object({
          id: z.string().uuid(),
          title: z.string().min(1),
          courseId: z.string().uuid().nullable(),
        })
        .parse(body);
    },

    async resumeConversation(id: string): Promise<ConversationResume> {
      const body = await request(
        `/api/opening/conversations/${id}/resume`,
        { method: "GET" },
        fetchImpl,
      );
      return conversationResumeSchema.parse(body);
    },

    async listTurns(conversationId: string): Promise<TurnRecord[]> {
      const body = await request(
        `/api/opening/conversations/${conversationId}/turns`,
        { method: "GET" },
        fetchImpl,
      );
      return turnListSchema.parse(body);
    },

    async getJob(jobId: string): Promise<JobStatusResponse> {
      const body = await request(
        `/api/opening/jobs/${jobId}`,
        { method: "GET" },
        fetchImpl,
      );
      return jobStatusResponseSchema.parse(body);
    },

    async submitTurn(
      input: TurnInput,
    ): Promise<{ jobId: string; turnId: string }> {
      const payload = turnInputSchema.parse(input);
      if (payload.privacy !== "saved") {
        throw new OpeningApiError(400, "thin chat only accepts privacy=saved");
      }
      const body = await request(
        "/api/opening/turns",
        { method: "POST", body: JSON.stringify(payload) },
        fetchImpl,
      );
      return z
        .object({ jobId: z.string().uuid(), turnId: z.string().uuid() })
        .parse(body);
    },

    async listSources(): Promise<SourceRecord[]> {
      const body = await request("/api/opening/sources", { method: "GET" }, fetchImpl);
      return sourceListSchema.parse(body);
    },

    async beginUpload(input: UploadInput): Promise<UploadTicket> {
      const payload = uploadInputSchema.parse(input);
      const body = await request(
        "/api/opening/sources",
        { method: "POST", body: JSON.stringify(payload) },
        fetchImpl,
      );
      return uploadTicketSchema.parse(body);
    },

    async completeUpload(sourceId: string): Promise<SourceRecord> {
      const body = await request(
        `/api/opening/sources/${sourceId}/complete`,
        { method: "POST", body: JSON.stringify({}) },
        fetchImpl,
      );
      return sourceRecordSchema.parse(body);
    },
  };
}

export type OpeningApi = ReturnType<typeof createOpeningApi>;
