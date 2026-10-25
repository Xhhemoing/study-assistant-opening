import "server-only";
import { loadEnv, loadOpeningJobStaleConfig } from "@aistudy/config";
import { createOpeningTutorJobsRepository, type OpeningScope, type OpeningTutorJobRecord } from "@aistudy/database";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { createTutorStreamReader, type TutorStreamSnapshot } from "../../../../../worker/src/runtime/tutor-stream";
import { ApiError } from "../../auth/service";

type StreamJob = Pick<OpeningTutorJobRecord, "status" | "assistantTurnId" | "conversationId">;
type StreamReader = {
  read(): Promise<TutorStreamSnapshot | null>;
  subscribe(onDelta: () => void, onUnavailable: () => void): Promise<() => Promise<void>>;
};

const isTerminal = (job: StreamJob) => job.status !== "queued" && job.status !== "running";
const encoder = new TextEncoder();

/** Cache bytes are tentative; PostgreSQL owns both permission and completion. */
export async function createJobStreamResponse(input: {
  job: StreamJob;
  signal: AbortSignal;
  reader: StreamReader;
  getJob(): Promise<StreamJob | null>;
  authorizeSnapshot(snapshot: TutorStreamSnapshot): Promise<StreamJob | null>;
  close(): void;
}): Promise<Response> {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let unsubscribe: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let pending = false;
  let firstSnapshot = true;
  let sentText = "";
  let sentSequence = 0;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    input.signal.removeEventListener("abort", close);
    const cleanup = unsubscribe;
    unsubscribe = undefined;
    // Disconnect is unconditional even when a subscription has already failed.
    if (cleanup) void cleanup().catch(() => undefined).finally(input.close);
    else input.close();
    controller?.close();
  };
  const send = (event: string, data: unknown, sequence?: number) => {
    if (!closed) controller?.enqueue(encoder.encode(
      `${sequence === undefined ? "" : `id: ${sequence}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    ));
  };
  const terminal = (job: StreamJob) => {
    send("terminal", { status: job.status, assistantTurnId: job.assistantTurnId, conversationId: job.conversationId });
    close();
  };
  const flush = async () => {
    if (!controller || closed || busy) return;
    busy = true;
    try {
      do {
        pending = false;
        const snapshot = await input.reader.read();
        if (closed) break;
        // Empty snapshots never deliver help. Every nonempty batch is checked
        // against live source/privacy facts before its bytes leave the server.
        const job = snapshot?.text
          ? await input.authorizeSnapshot(snapshot)
          : await input.getJob();
        if (closed) break;
        if (!job) { close(); break; }
        if (isTerminal(job)) { terminal(job); break; }
        if (snapshot?.text && job.status !== "running") break;
        const identity = { assistantTurnId: job.assistantTurnId, conversationId: job.conversationId };
        const text = snapshot?.text ?? "";
        const sequence = snapshot?.sequence ?? 0;
        if (firstSnapshot || sequence < sentSequence || sequence > sentSequence + 1 || !text.startsWith(sentText)) {
          send("snapshot", { ...identity, text, sequence }, sequence);
          firstSnapshot = false;
        } else if (sequence > sentSequence && text.length > sentText.length) {
          send("delta", { ...identity, text: text.slice(sentText.length), sequence }, sequence);
        }
        sentText = text;
        sentSequence = sequence;
      } while (pending && !closed);
    } catch {
      // The normal job endpoint remains the recovery path. In particular,
      // permission failures never serialize an old cached answer or raw error.
      close();
    } finally {
      busy = false;
    }
  };
  const wake = () => { pending = true; void flush(); };

  if (!isTerminal(input.job)) {
    try {
      unsubscribe = await input.reader.subscribe(wake, close);
    } catch {
      input.close();
      throw new ApiError("SERVICE_UNAVAILABLE", "实时回答暂不可用，请稍后查看完整回答。", 503);
    }
  }
  if (closed || input.signal.aborted) {
    // An abort during subscribe still owns the newly created subscriber.
    await unsubscribe?.().catch(() => undefined);
    input.close();
    return new Response(null, { status: 204 });
  }
  const body = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      input.signal.addEventListener("abort", close, { once: true });
      if (isTerminal(input.job)) { terminal(input.job); return; }
      wake();
      // Completion is a database fact, not a Redis event. This also handles
      // failure/cancellation before the model has emitted any text.
      timer = setInterval(() => {
        void input.getJob().then(job => {
          if (closed) return;
          if (!job) close();
          else if (isTerminal(job)) terminal(job);
        }).catch(close);
      }, 1_000);
    },
    cancel() { controller = undefined; close(); },
  });
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "private, no-cache, no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  } });
}

export async function openTutorJobStream(
  sql: Sql, scope: OpeningScope, job: OpeningTutorJobRecord, signal: AbortSignal,
): Promise<Response> {
  const jobs = createOpeningTutorJobsRepository(sql, { staleMs: loadOpeningJobStaleConfig().tutorJobStaleMs });
  if (isTerminal(job)) {
    return createJobStreamResponse({ job, signal,
      reader: { read: async () => null, subscribe: async () => async () => undefined },
      getJob: () => jobs.get(scope, job.id), authorizeSnapshot: async () => job, close: () => undefined });
  }
  const redis = new Redis(loadEnv(process.env).redisUrl, {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
    connectTimeout: 2_000, commandTimeout: 2_000, retryStrategy: () => null,
  });
  // ioredis errors can contain connection strings. Surface only the bounded
  // transport failure; persisted job completion remains available by polling.
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const reader = createTutorStreamReader(redis);
    return await createJobStreamResponse({ job, signal,
      reader: {
        read: () => reader.read(scope.workspaceId, job.id),
        subscribe: (onDelta, onUnavailable) => reader.subscribe(scope.workspaceId, job.id, onDelta, onUnavailable),
      },
      getJob: () => jobs.get(scope, job.id),
      authorizeSnapshot: snapshot => jobs.readStream(scope, job.id, snapshot),
      close: () => redis.disconnect(),
    });
  } catch (error) {
    redis.disconnect();
    if (error instanceof ApiError) throw error;
    throw new ApiError("SERVICE_UNAVAILABLE", "实时回答暂不可用，请稍后查看完整回答。", 503);
  }
}
