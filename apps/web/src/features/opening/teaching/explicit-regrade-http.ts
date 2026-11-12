import { z } from "zod";
import { aiGradingStatusSchema, explicitRegradeRequestSchema, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { createSessionFetch } from "../../auth/session-expiry";
import type { ExplicitRegradeAdapter } from "./explicit-regrade-client";

export const regradeSnapshotSchema = z.object({
  rootObservationId: z.string().uuid(), expectedHead: z.string().uuid(),
  answerRevision: z.number().int().positive(), privacyEpoch: z.number().int().nonnegative(),
  previousGradingVersion: z.number().int().nonnegative(), oldStatus: aiGradingStatusSchema.shape.status,
}).strict();
export type RegradeServerSnapshot = z.infer<typeof regradeSnapshotSchema>;
const responseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared"), request: explicitRegradeRequestSchema, estimate: z.string().nullable(),
    estimateCents: z.number().int().nonnegative().nullable(), snapshot: regradeSnapshotSchema }),
  z.object({ kind: z.literal("progress"), progress: z.object({ request: explicitRegradeRequestSchema, status: aiGradingStatusSchema.nullable() }), snapshot: regradeSnapshotSchema }),
  z.object({ kind: z.literal("conflict"), snapshot: regradeSnapshotSchema }),
]);
export class RegradeHttpError extends Error {
  constructor(readonly status: number) { super("无法读取或确认本次评改"); }
}
const route = "/api/opening/observations/regrade";

/** No retries. Recovery is GET-only, with null query values omitted rather than serialized. */
export function createExplicitRegradeHttp(onSnapshot: (snapshot: RegradeServerSnapshot, request?: ExplicitRegradeRequest) => void,
  authorize: () => Promise<void>, fetchImpl: typeof fetch = fetch) {
  const sessionFetch = createSessionFetch(fetchImpl);
  async function call(path: string, body?: unknown) {
    await authorize();
    const response = await sessionFetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok && response.status !== 409) throw new RegradeHttpError(response.status);
    const raw: unknown = await response.json();
    if (response.status === 409) {
      const conflict = responseSchema.safeParse(raw);
      if (conflict.success && conflict.data.kind === "conflict") onSnapshot(conflict.data.snapshot);
      return { kind: "conflict" as const };
    }
    const result = responseSchema.parse(raw);
    onSnapshot(result.snapshot, result.kind === "prepared" ? result.request : result.kind === "progress" ? result.progress.request : undefined);
    // Only the server's real numeric estimate can unlock a separate confirmation.
    return result.kind === "prepared" ? { ...result, estimate: result.estimateCents === null ? null : result.estimate } : result;
  }
  const adapter: ExplicitRegradeAdapter = {
    prepare: input => call(route, input),
    confirm: async input => {
      const result = await call(`${route}/confirm`, input);
      if (result.kind === "prepared") throw new Error("确认响应缺少本次进度");
      return result;
    },
    read: input => call(`${route}?${new URLSearchParams({ observationId: input.observationId, clientKey: input.clientKey,
      ...(input.requestId === null ? {} : { requestId: input.requestId }) })}`),
  };
  return { adapter, async snapshot(observationId: string) {
    await authorize();
    const response = await sessionFetch(`${route}?${new URLSearchParams({ observationId })}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new RegradeHttpError(response.status);
    return z.object({ snapshot: regradeSnapshotSchema }).parse(await response.json()).snapshot;
  } };
}
