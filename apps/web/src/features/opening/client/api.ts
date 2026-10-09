import {
  snippetCreateInputSchema,
  snippetCreateResponseSchema,
  type SnippetCreateInput,
  type SnippetCreateResponse,
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
  type TaskItem,
  type TaskCreateInput,
  type TaskStatusUpdateInput,
  type CandidateRef,
  taskCreateInputSchema,
  taskStatusUpdateInputSchema,
  taskCreateResultSchema,
  taskItemSchema,
  type EphemeralTurnResponse,
  ephemeralTurnResponseSchema,
  assistantCandidateRecordSchema,
  memoryItemSchema,
  planDraftSchema,
  reminderListSchema,
  reminderSchema,
  reminderEnqueueInputSchema,
  learningSummarySchema,
  knowledgeSnapshotSchema,
  actionDigestSchema,
  actionCandidateSchema,
  connectionViewSchema,
  imapSetupInputSchema,
  mediaSegmentsResponseSchema,
  type ReminderList,
  type KnowledgeSnapshot,
  type ActionDigest,
  type ActionCandidate,
  type ConnectionView,
  type ImapSetupInput,
  type MediaSegmentsResponse,
} from "@aistudy/contracts";
import { z } from "zod";
import { retestReviewSchema } from "../planning/review-types";

export type { JobStatusResponse } from "@aistudy/contracts";

const thinTutorActionSchema = z.object({
  kind: z.enum(["clarify", "guided", "worked_example", "independent_variant", "delayed_retest"]),
  skillLabel: z.string().min(1).max(200),
  currentPage: z.number().int().positive().nullable(),
  nodeId: z.string().uuid().nullable(),
  problemRef: z.string().max(240).nullable(),
  reason: z.string().min(1).max(2000),
  evidenceIds: z.array(z.string()).max(200),
});

export type ThinTutorActionView = z.infer<typeof thinTutorActionSchema>;

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
const dailyDraftSkippedReasonSchema = z.enum(["accepted", "rejected", "no_settings"]);
const todayPlanSchema = z.object({
  date: z.string(),
  acceptedVersion: z.number().int().nonnegative(),
  blocks: z.array(z.object({ taskId: z.string().uuid(), start: z.string(), end: z.string(), reason: z.string() })),
  hardBlocks: z.array(z.object({ start: z.string(), end: z.string(), kind: z.enum(["class", "sleep", "meal", "locked", "free"]) })),
  dailyDraft: planDraftSchema.nullable().optional(),
  dailyDraftSkippedReason: dailyDraftSkippedReasonSchema.nullable().optional(),
  unplannedPendingCount: z.number().int().nonnegative().optional(),
});
export type TodayPlanRead = z.infer<typeof todayPlanSchema>;
const taskListSchema = z.object({ tasks: z.array(taskItemSchema) });

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
    ): Promise<EphemeralTurnResponse> {
      const body = await request(
        "/api/opening/ephemeral",
        { method: "POST", body: JSON.stringify(input), signal },
        fetchImpl,
      );
      return ephemeralTurnResponseSchema.parse(body);
    },

    async createSnippet(input: SnippetCreateInput): Promise<SnippetCreateResponse> {
      const payload = snippetCreateInputSchema.parse(input);
      const body = await request(
        "/api/opening/snippets",
        { method: "POST", body: JSON.stringify(payload) },
        fetchImpl,
      );
      return snippetCreateResponseSchema.parse(body);
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

    async retryParse(sourceId: string): Promise<SourceRecord> {
      const body = await request(
        `/api/opening/sources/${sourceId}/retry`,
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

    async createTask(input: TaskCreateInput) {
      const body = await request("/api/opening/tasks", { method: "POST", body: JSON.stringify(taskCreateInputSchema.parse(input)) }, fetchImpl);
      return taskCreateResultSchema.parse(body);
    },

    async updateTaskStatus(taskId: string, input: TaskStatusUpdateInput) {
      const body = await request(`/api/opening/tasks/${taskId}`, {
        method: "PATCH", body: JSON.stringify(taskStatusUpdateInputSchema.parse(input)),
      }, fetchImpl);
      return taskListSchema.shape.tasks.element.parse(body);
    },

    async listRetestCandidates() {
      const body = await request("/api/opening/retests", { method: "GET" }, fetchImpl);
      return z.array(retestReviewSchema).parse(body);
    },

    async acceptRetest(id: string, clientKey: string) {
      const body = await request(`/api/opening/retests/${id}/accept`, { method: "POST", body: JSON.stringify({ clientKey }) }, fetchImpl);
      return z.object({ taskId: z.string().uuid(), accepted: z.literal(true), scheduled: z.literal(false) }).parse(body);
    },

    async discardCandidate(ref: CandidateRef, clientKey: string) {
      if (ref.kind === "memory") throw new Error("记忆建议请使用记忆决定接口。");
      const path = ref.origin === "assistant" ? `/api/opening/candidates/${ref.id}/discard` : `/api/opening/retests/${ref.id}/discard`;
      const body = await request(path, { method: "POST", body: JSON.stringify({ candidateRef: ref, clientKey }) }, fetchImpl);
      return z.object({ id: z.string().uuid(), status: z.literal("discarded") }).parse(body);
    },
    async listTutorActions(input: {
      courseId: string;
      skillLabel: string;
      sessionId?: string | null;
      currentPage?: number | null;
      nodeId?: string | null;
      sourceIds?: string[];
    }): Promise<ThinTutorActionView[]> {
      const params = new URLSearchParams({ skillLabel: input.skillLabel });
      if (input.sessionId) params.set("sessionId", input.sessionId);
      if (input.currentPage != null) params.set("currentPage", String(input.currentPage));
      if (input.nodeId) params.set("nodeId", input.nodeId);
      if (input.sourceIds?.length) params.set("sourceIds", input.sourceIds.join(","));
      const body = await request(
        `/api/opening/courses/${input.courseId}/tutor-actions?${params}`,
        { method: "GET" },
        fetchImpl,
      );
      return z.object({ actions: z.array(thinTutorActionSchema) }).parse(body).actions;
    },

    async getCourseKnowledge(courseId: string): Promise<{
      version: number;
      snapshot: KnowledgeSnapshot;
      sourceVersions: Record<string, number>;
    }> {
      const body = await request(
        `/api/opening/courses/${courseId}/knowledge`,
        { method: "GET" },
        fetchImpl,
      );
      return z
        .object({
          version: z.number().int().nonnegative(),
          snapshot: knowledgeSnapshotSchema,
          sourceVersions: z.record(z.string(), z.number().int().nonnegative()),
        })
        .parse(body);
    },

    async getLearning(courseId: string) {
      const body = await request(`/api/opening/courses/${courseId}/learning`, { method: "GET" }, fetchImpl);
      return z.array(learningSummarySchema).parse(body);
    },

    async requestTaskReminder(input: { clientKey: string; channel?: "in_app" | "feishu"; taskId: string; expectedVersion: number }) {
      const payload = reminderEnqueueInputSchema.parse(input);
      const body = await request("/api/opening/reminders", { method: "POST", body: JSON.stringify(payload) }, fetchImpl);
      return z.object({ reminders: z.array(reminderSchema).length(1) }).strict().refine(result => {
        const reminder = result.reminders[0];
        return Boolean(reminder && reminder.taskId === input.taskId && reminder.taskVersion === input.expectedVersion && reminder.channel === payload.channel);
      }, "reminder response does not match the requested task and version").parse(body);
    },
    async listReminders(): Promise<ReminderList> {
      const body = await request("/api/opening/reminders", { method: "GET" }, fetchImpl);
      return reminderListSchema.parse(body);
    },

    async getToday(date: string): Promise<TodayPlanRead> {
      const body = await request(`/api/opening/today?date=${encodeURIComponent(date)}`, { method: "GET" }, fetchImpl);
      return todayPlanSchema.parse(body);
    },

    async listTasks(): Promise<{ tasks: TaskItem[] }> {
      const body = await request("/api/opening/tasks", { method: "GET" }, fetchImpl);
      return taskListSchema.parse(body);
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

    async getActionDigest(): Promise<ActionDigest> {
      const body = await request("/api/opening/action-digest", { method: "GET" }, fetchImpl);
      return actionDigestSchema.parse(body);
    },

    async decideActionDigest(input: {
      decision: "accept" | "reject";
      candidateId: string;
      clientKey: string;
    }): Promise<{ candidate: ActionCandidate; digest: ActionDigest }> {
      const body = await request(
        "/api/opening/action-digest",
        { method: "POST", body: JSON.stringify(input) },
        fetchImpl,
      );
      return z
        .object({
          candidate: actionCandidateSchema,
          digest: actionDigestSchema,
        })
        .strict()
        .parse(body);
    },

    async listConnections(): Promise<ConnectionView[]> {
      const body = await request("/api/opening/connections", { method: "GET" }, fetchImpl);
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { connections?: unknown } | null)?.connections)
          ? (body as { connections: unknown[] }).connections
          : [];
      return z.array(connectionViewSchema).parse(rows);
    },

    async createImapConnection(input: ImapSetupInput): Promise<ConnectionView> {
      const payload = imapSetupInputSchema.parse(input);
      const body = await request(
        "/api/opening/connections/imap",
        { method: "POST", body: JSON.stringify(payload) },
        fetchImpl,
      );
      return connectionViewSchema.parse(body);
    },

    async putConnectionCredential(
      connectionId: string,
      input: { secret: string; clientKey: string },
    ): Promise<void> {
      await request(
        `/api/opening/connections/${connectionId}/credential`,
        { method: "PUT", body: JSON.stringify(input) },
        fetchImpl,
      );
    },

    async syncConnection(
      connectionId: string,
      input: { clientKey: string },
    ): Promise<unknown> {
      return request(
        `/api/opening/connections/${connectionId}/sync`,
        { method: "POST", body: JSON.stringify(input) },
        fetchImpl,
      );
    },

    async revokeConnection(
      connectionId: string,
      input: { expectedVersion: number; clientKey: string },
    ): Promise<ConnectionView> {
      const body = await request(
        `/api/opening/connections/${connectionId}/revoke`,
        { method: "POST", body: JSON.stringify(input) },
        fetchImpl,
      );
      return connectionViewSchema.parse(body);
    },

    async importEmailManual(file: File): Promise<unknown> {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchImpl("/api/opening/imports/email", { method: "POST", body: form });
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
    },

    async getSourceSegments(sourceId: string): Promise<MediaSegmentsResponse> {
      const body = await request(
        `/api/opening/sources/${sourceId}/segments`,
        { method: "GET" },
        fetchImpl,
      );
      return mediaSegmentsResponseSchema.parse(body);
    },
  };
}

export type OpeningApi = ReturnType<typeof createOpeningApi>;
