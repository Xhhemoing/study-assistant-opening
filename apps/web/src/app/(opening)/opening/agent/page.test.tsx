import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import type { StudyConversationContext } from "@/features/opening/assistant/study-conversation-context";
vi.mock("@/features/opening/assistant/agent-workspace", () => ({ AgentWorkspace: () => null }));
vi.mock("@/features/opening/assistant/assistant-entry", async () => import("../../../../features/opening/assistant/assistant-entry"));
vi.mock("@/features/opening/assistant/conversation-links", async () => import("../../../../features/opening/assistant/conversation-links"));
import AgentPage from "./page";

const id = "11111111-1111-4111-8111-111111111111";
type Page = ReactElement<{ initialConversationId?: string | null; initialContext?: StudyConversationContext; initialContextError?: string }>;
it("keeps a separately validated saved id alongside strictly parsed question context", async () => {
  const page = await AgentPage({ searchParams: Promise.resolve({ conversation: id, courseId: id, activityId: id, attemptId: id, source: id, version: "0", page: "2" }) }) as Page;
  expect(page.props.initialConversationId).toBe(id);
  expect(page.props.initialContext).toMatchObject({ courseId: id, activityId: id, attemptId: id, sourceId: id, sourceVersion: 0, page: 2 });
});
it("does not downgrade malformed question context or conversation ids to a fresh sendable chat", async () => {
  const badContext = await AgentPage({ searchParams: Promise.resolve({ conversation: id, attemptId: "bad" }) }) as Page;
  expect(badContext.props.initialContextError).toBeTruthy();
  const badId = await AgentPage({ searchParams: Promise.resolve({ conversation: "bad" }) }) as Page;
  expect(badId.props.initialContextError).toBeTruthy();
  expect(badId.props.initialConversationId).toBeNull();
  const blocked = await AgentPage({ searchParams: Promise.resolve({ contextError: "1" }) }) as Page;
  expect(blocked.props.initialContextError).toBeTruthy();
});
