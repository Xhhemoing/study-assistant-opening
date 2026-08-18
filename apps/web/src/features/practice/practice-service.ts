import {
  requestHintResponseSchema,
  revealAnswerResponseSchema,
  startPracticeResponseSchema,
} from "@aistudy/contracts";
import {
  createPracticeContentRepository,
  createPracticeSessionRepository,
  PracticeContentRepositoryError,
} from "@aistudy/database";
import { z } from "zod";
import type { Principal } from "../../lib/authorization";
import type { AuthRuntime } from "../auth/service";

const sessionBodySchema = z.object({ sessionId: z.string().uuid() }).strict();

function repos(runtime: AuthRuntime) {
  return {
    content: createPracticeContentRepository(runtime.sql),
    sessions: createPracticeSessionRepository(runtime.sql),
  };
}

async function requireOwnedSession(
  runtime: AuthRuntime,
  principal: Principal,
  itemId: string,
  body: unknown,
) {
  const { sessionId } = sessionBodySchema.parse(body);
  const session = await repos(runtime).sessions.lock({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    sessionId,
  });
  if (session.practiceItemId !== itemId) {
    throw new PracticeContentRepositoryError(
      "VALIDATION",
      "Practice session item must match the route item",
    );
  }
  return session;
}

export async function startPracticeForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  itemId: string,
) {
  const { content, sessions } = repos(runtime);
  const session = await sessions.start({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    practiceItemId: itemId,
  });
  const item = await content.getPublicItem({
    workspaceId: principal.workspaceId,
    itemId,
  });
  return startPracticeResponseSchema.parse({ sessionId: session.id, item });
}

export async function requestHintForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  itemId: string,
  body: unknown,
) {
  const session = await requireOwnedSession(runtime, principal, itemId, body);
  const result = await repos(runtime).sessions.recordHint({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    sessionId: session.id,
  });
  return requestHintResponseSchema.parse({
    hintIndex: result.session.hintCount - 1,
    hint: result.hint,
  });
}

export async function revealAnswerForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  itemId: string,
  body: unknown,
) {
  const session = await requireOwnedSession(runtime, principal, itemId, body);
  await repos(runtime).sessions.recordAnswerReveal({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    sessionId: session.id,
  });
  const item = await repos(runtime).content.getGradableVersion({
    workspaceId: principal.workspaceId,
    itemId: session.practiceItemId,
    version: session.contentVersion,
  });
  return revealAnswerResponseSchema.parse({ answer: item.answerDisplay });
}
