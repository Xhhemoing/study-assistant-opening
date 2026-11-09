import {
  attemptEventSchema,
  submitAttemptRequestSchema,
  type AttemptEvent,
  type LearningEvent,
  type StatusResult,
} from "@aistudy/contracts";
import {
  createLearningEventRepository,
  createPracticeContentRepository,
  createPracticeSessionRepository,
  lockWorkspaceLearningHistory,
  PracticeContentRepositoryError,
} from "@aistudy/database";
import { gradePracticeAnswer } from "@aistudy/domain";
import type { Sql } from "postgres";
import type { Principal } from "../../lib/authorization";
import { listAssessmentForPrincipal } from "../assessment/assessment-service";
import type { AuthRuntime } from "../auth/service";

export function learningEventToAttempt(event: LearningEvent, practiceItemId: string): AttemptEvent {
  if (event.type !== "attempt") {
    throw new Error("Only attempt learning events can be mapped to practice attempts");
  }
  return attemptEventSchema.parse({
    id: event.id,
    ownerUserId: event.ownerUserId,
    practiceItemId,
    syllabusPointId: event.syllabusPointId,
    idempotencyKey: event.idempotencyKey,
    answer: event.payload.answer,
    correct: event.payload.correct,
    assisted: event.payload.assisted,
    durationMs: event.payload.durationMs,
    hintCount: event.payload.hintCount,
    confidence: event.payload.confidence,
    errorCause: event.payload.errorCause,
    abilitySlice: event.payload.abilitySlice,
    contentVersion: event.contentVersion,
    schemaVersion: event.schemaVersion,
    createdAt: event.createdAt,
  });
}

export async function submitAttemptForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<{ event: AttemptEvent; status: StatusResult }> {
  const parsed = submitAttemptRequestSchema.parse(body);
  const submittedAt = new Date();
  const submitted = await runtime.sql.begin(async (tx) => {
    const client = tx as Sql;
    const sessions = createPracticeSessionRepository(client);
    const content = createPracticeContentRepository(client);
    const events = createLearningEventRepository(client);
    // Keep legacy owner/session/item/replay errors ahead of the new history wait,
    // without acquiring business locks. The original locked reads still run below.
    const [owner] = await client`SELECT owner_user_id FROM workspaces WHERE id=${principal.workspaceId} LIMIT 1`;
    if (!owner) throw new PracticeContentRepositoryError("NOT_FOUND", `Workspace not found: ${principal.workspaceId}`);
    if (owner.owner_user_id !== principal.userId) {
      throw new PracticeContentRepositoryError("WORKSPACE_MISMATCH", "Practice session owner must match workspace owner");
    }
    const [candidate] = await client`SELECT practice_item_id,content_version,submitted_at FROM practice_sessions
      WHERE workspace_id=${principal.workspaceId} AND owner_user_id=${principal.userId} AND id=${parsed.practiceSessionId} LIMIT 1`;
    if (!candidate) throw new PracticeContentRepositoryError("NOT_FOUND", `Practice session ${parsed.practiceSessionId} was not found`);
    const precheckedItem = await content.getGradableVersion({
      workspaceId: principal.workspaceId, itemId: String(candidate.practice_item_id), version: Number(candidate.content_version),
    });
    const replay = await events.findByIdempotency({
      workspaceId: principal.workspaceId, ownerUserId: principal.userId, idempotencyKey: parsed.idempotencyKey,
    });
    if (replay) learningEventToAttempt(replay, precheckedItem.id);
    else if (candidate.submitted_at) {
      throw new PracticeContentRepositoryError("CONFLICT", "Submitted session cannot be reused with a different idempotency key");
    }
    await lockWorkspaceLearningHistory(tx, { workspaceId: principal.workspaceId, ownerUserId: principal.userId });
    // Hold the validated owner stable through event + submission. Drift during the
    // new wait is rejected, never followed to another history key.
    const [lockedOwner] = await client`SELECT owner_user_id FROM workspaces WHERE id=${principal.workspaceId} FOR SHARE`;
    if (!lockedOwner) throw new PracticeContentRepositoryError("NOT_FOUND", `Workspace not found: ${principal.workspaceId}`);
    if (lockedOwner.owner_user_id !== principal.userId) {
      throw new PracticeContentRepositoryError("CONFLICT", "Practice session owner changed while waiting for history");
    }
    const session = await sessions.lock({
      workspaceId: principal.workspaceId,
      ownerUserId: principal.userId,
      sessionId: parsed.practiceSessionId,
    });
    // A changed session binding is a new safe rejection boundary, not a key to retry.
    if (session.practiceItemId !== candidate.practice_item_id || session.contentVersion !== Number(candidate.content_version)) {
      throw new PracticeContentRepositoryError("CONFLICT", "Practice session content changed while waiting for history");
    }
    const item = await content.getGradableVersion({
      workspaceId: principal.workspaceId,
      itemId: session.practiceItemId,
      version: session.contentVersion,
    });
    const replayed = await events.findByIdempotency({
      workspaceId: principal.workspaceId,
      ownerUserId: principal.userId,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (replayed) {
      return { event: learningEventToAttempt(replayed, item.id) };
    }
    if (session.submittedAt) {
      throw new PracticeContentRepositoryError(
        "CONFLICT",
        "Submitted session cannot be reused with a different idempotency key",
      );
    }
    const assisted = session.hintCount > 0 || session.answerRevealedAt !== null;
    const event = await events.append({
      workspaceId: principal.workspaceId,
      ownerUserId: principal.userId,
      type: "attempt",
      idempotencyKey: parsed.idempotencyKey,
      occurredAt: submittedAt.toISOString(),
      contentId: item.id,
      contentVersion: item.contentVersion,
      syllabusPointId: item.syllabusPointId,
      payload: {
        answer: parsed.answer,
        correct: gradePracticeAnswer(item.answerRule, parsed.answer),
        assisted,
        durationMs: Math.max(0, submittedAt.getTime() - new Date(session.startedAt).getTime()),
        hintCount: session.hintCount,
        confidence: parsed.confidence,
        errorCause: parsed.errorCause,
        abilitySlice: item.abilitySlice,
      },
    });
    await sessions.markSubmitted({
      workspaceId: principal.workspaceId,
      ownerUserId: principal.userId,
      sessionId: session.id,
      idempotencyKey: parsed.idempotencyKey,
    });
    return { event: learningEventToAttempt(event, item.id) };
  });
  const { statuses } = await listAssessmentForPrincipal(
    runtime,
    principal,
    { syllabusPointId: submitted.event.syllabusPointId },
    submittedAt,
  );
  const status = statuses[0];
  if (!status) {
    throw new PracticeContentRepositoryError(
      "NOT_FOUND",
      `Assessment missing for ${submitted.event.syllabusPointId}`,
    );
  }
  return { event: submitted.event, status };
}
