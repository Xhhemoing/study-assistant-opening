import {
  appendStatusCorrectionRequestSchema,
  assessmentQuerySchema,
  type LearningEvent,
  type StatusResult,
} from "@aistudy/contracts";
import { LearningEventRepositoryError } from "@aistudy/database";
import type { Principal } from "../../lib/authorization";
import type { AuthRuntime } from "../auth/service";
import { statusesFromEvents } from "./assessment-replay-model";

export { statusesFromEvents } from "./assessment-replay-model";

function notFound(eventId: string): never {
  throw new LearningEventRepositoryError("NOT_FOUND", `Learning event not found: ${eventId}`);
}

async function loadVisibleEvent(
  runtime: AuthRuntime,
  principal: Principal,
  eventId: string,
): Promise<LearningEvent> {
  try {
    const event = await runtime.learningEvents.get({
      workspaceId: principal.workspaceId,
      eventId,
    });
    if (event.ownerUserId !== principal.userId) notFound(eventId);
    return event;
  } catch (error) {
    if (error instanceof LearningEventRepositoryError && error.code === "WORKSPACE_MISMATCH") {
      notFound(eventId);
    }
    throw error;
  }
}

export async function listAssessmentForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  query: unknown,
  now = new Date(),
): Promise<{ statuses: StatusResult[] }> {
  const parsed = assessmentQuerySchema.parse(query);
  const events = await runtime.learningEvents.listForOwner({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    syllabusPointId: parsed.syllabusPointId,
  });
  return { statuses: statusesFromEvents(events, now) };
}

export async function appendStatusCorrectionForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
  now = new Date(),
): Promise<{ event: LearningEvent; status: StatusResult }> {
  const parsed = appendStatusCorrectionRequestSchema.parse(body);
  const target = await loadVisibleEvent(runtime, principal, parsed.correctsEventId);
  const event = await runtime.learningEvents.append({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    type: "correction",
    idempotencyKey: parsed.idempotencyKey,
    occurredAt: now.toISOString(),
    correctsEventId: target.id,
    contentId: target.contentId,
    contentVersion: target.contentVersion,
    syllabusPointId: target.syllabusPointId,
    payload: {
      kind: "status",
      note: parsed.note,
      overrideStatus: parsed.overrideStatus ?? null,
    },
  });
  const pointId = event.syllabusPointId ?? target.syllabusPointId;
  if (!pointId) {
    throw new LearningEventRepositoryError("VALIDATION", "Correction target has no syllabus point");
  }
  const { statuses } = await listAssessmentForPrincipal(
    runtime,
    principal,
    { syllabusPointId: pointId },
    now,
  );
  const status = statuses[0];
  if (!status) {
    throw new LearningEventRepositoryError("NOT_FOUND", `Assessment missing for ${pointId}`);
  }
  return { event, status };
}
