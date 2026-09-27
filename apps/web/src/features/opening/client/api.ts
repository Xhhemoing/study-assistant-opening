import {
  conversationCreateInputSchema,
  conversationResumeSchema,
  conversationSummarySchema,
  jobStatusResponseSchema,
  sourceDownloadSchema,
  sourceRecordSchema,
  turnInputSchema,
  turnRecordSchema,
  uploadInputSchema,
  uploadTicketSchema,
  type ConversationCreateInput,
  type ConversationResume,
  type ConversationSummary,
  type JobStatusResponse,
  type SourceDownload,
  type SourceRecord,
  type TurnInput,
  type TurnRecord,
  type UploadInput,
  type UploadTicket,
  type AssistantCandidateRecord,
  type EphemeralTurnInput,
  type MemoryDecision,
  type MemoryCandidateDecision,
  type MemoryItem,
  type PlanDraft,
  type PlannedBlock,
  type TaskItem,
  type ProviderOutput,
  providerOutputSchema,
  assistantCandidateRecordSchema,
  memoryItemSchema,
  planDraftSchema,
  reminderListSchema,
  learningSummarySchema,
  type ReminderList,
} from "@aistudy/contracts";
import { z } from "zod";

export type { JobStatusResponse } from "@aistudy/contracts";

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
const memoryCardSchema = memoryItemSchema.extend({ why: z.array(z.string()), when: z.string() });
const todayPlanSchema = z.object({
  date: z.string(),
  acceptedVersion: z.number().int().nonnegative(),
  blocks: z.array(z.object({ taskId: z.string().uuid(), start: z.string(), end: z.string(), reason: z.string() })),
  hardBlocks: z.array(z.object({ start: z.string(), end: z.string(), kind: z.enum(["class", "sleep", "meal", "locked", "free"]) })),
});
const taskListSchema = z.object({ tasks: z.array(z.object({
  id: z.string().uuid(), title: z.string(), minutes: z.number().int().positive(), dueAt: z.string().nullable(), priority: z.number(), status: z.enum(["pending", "done", "skipped"]),
})) });

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

    async cancelJob(jobId: string): Promise<JobStatusResponse> {
      const body = await request(`/api/opening/jobs/${jobId}`, { method: "DELETE" }, fetchImpl);
      return jobStatusResponseSchema.parse(body);
    },

    async getPendingJob(conversationId: string): Promise<JobStatusResponse | null> {
      const body = await request(
        `/api/opening/conversations/${conversationId}/pending-job`,
        { method: "GET" },
        fetchImpl,
      );
      return jobStatusResponseSchema.nullable().parse(body);
    },

    async replyEphemeral(
      input: EphemeralTurnInput,
      signal?: AbortSignal,
    ): Promise<ProviderOutput> {
      const body = await request(
        "/api/opening/ephemeral",
        { method: "POST", body: JSON.stringify(input), signal },
        fetchImpl,
      );
      return providerOutputSchema.parse(body);
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

    async getSourceDownload(sourceId: string, version: number): Promise<SourceDownload> {
      const body = await request(
        `/api/opening/sources/${sourceId}/download?version=${version}`,
        { method: "GET" },
        fetchImpl,
      );
      return sourceDownloadSchema.parse(body);
    },

    async listMemory(courseId: string | null = null): Promise<{ items: MemoryItem[]; context: MemoryItem[]; review: MemoryItem[] }> {
      const query = courseId ? `?courseId=${encodeURIComponent(courseId)}` : "";
      const body = await request(`/api/opening/memory${query}`, { method: "GET" }, fetchImpl);
      return z.object({ items: z.array(memoryCardSchema), context: z.array(memoryCardSchema), review: z.array(memoryCardSchema) }).parse(body);
    },

    async decideMemory(input: MemoryDecision): Promise<MemoryItem> {
      const body = await request(`/api/opening/memory/${input.id}/decision`, {
        method: "POST", body: JSON.stringify(input),
      }, fetchImpl);
      return memoryCardSchema.parse(body);
    },

    async decideMemoryCandidate(input: MemoryCandidateDecision): Promise<MemoryItem> {
      const body = await request(`/api/opening/candidates/${input.id}/memory-decision`, {
        method: "POST", body: JSON.stringify(input),
      }, fetchImpl);
      return memoryCardSchema.parse(body);
    },

    async listCandidates(): Promise<AssistantCandidateRecord[]> {
      const body = await request("/api/opening/candidates", { method: "GET" }, fetchImpl);
      return z.array(assistantCandidateRecordSchema).parse(body);
    },

    async getLearning(courseId: string) {
      const body = await request(`/api/opening/courses/${courseId}/learning`, { method: "GET" }, fetchImpl);
      return z.array(learningSummarySchema).parse(body);
    },

    async listReminders(): Promise<ReminderList> {
      const body = await request("/api/opening/reminders", { method: "GET" }, fetchImpl);
      return reminderListSchema.parse(body);
    },

    async getToday(date: string) {
      const body = await request(`/api/opening/today?date=${encodeURIComponent(date)}`, { method: "GET" }, fetchImpl);
      return todayPlanSchema.parse(body) as { date: string; acceptedVersion: number; blocks: PlannedBlock[]; hardBlocks: Array<{ start: string; end: string; kind: "class" | "sleep" | "meal" | "locked" | "free" }> };
    },

    async listTasks(): Promise<{ tasks: TaskItem[] }> {
      const body = await request("/api/opening/tasks", { method: "GET" }, fetchImpl);
      return taskListSchema.parse(body) as { tasks: TaskItem[] };
    },

    async proposePlan(input: unknown): Promise<PlanDraft> {
      const body = await request("/api/opening/plans", { method: "POST", body: JSON.stringify(input) }, fetchImpl);
      return planDraftSchema.parse(body);
    },

    async acceptPlan(input: { draftId: string; expectedBaseVersion: number; clientKey: string }): Promise<PlanDraft> {
      const body = await request(`/api/opening/plans/${input.draftId}/accept`, { method: "POST", body: JSON.stringify(input) }, fetchImpl);
      return planDraftSchema.parse(body);
    },

    async rejectPlan(draftId: string): Promise<PlanDraft> {
      const body = await request(`/api/opening/plans/${draftId}/reject`, { method: "POST", body: JSON.stringify({}) }, fetchImpl);
      return planDraftSchema.parse(body);
    },
  };
}

export type OpeningApi = ReturnType<typeof createOpeningApi>;
