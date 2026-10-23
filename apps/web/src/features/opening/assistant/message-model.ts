import type { Citation, ConversationResume, EphemeralTurnInput, TurnRecord } from "@aistudy/contracts";

import { queryEvidenceLinks, querySteps, type QueryEvidenceLink, type QueryStep } from "./query-evidence-links";
import type { StreamingReply } from "./job-stream";

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  citationLabels: string[];
  status?: TurnRecord["status"];
  origin?: "saved" | "ephemeral";
  provenanceId?: string | null;
  systemQuery?: boolean;
  queryEvidenceLinks?: readonly QueryEvidenceLink[];
  /** 回答前读过的记录（Agent 步骤行） */
  querySteps?: readonly QueryStep[];
  /** True when this assistant turn had selected materials / context intent (T02 general label). */
  hadMaterialContext?: boolean;
  /** Provider text has already appeared incrementally; never replay a reveal animation. */
  streamed?: boolean;
};

/** Streaming text never replaces a persisted terminal answer or its provenance. */
export function messagesWithStreamingReply(messages: ChatMessageView[], reply: StreamingReply | null): ChatMessageView[] {
  if (!reply?.text) return messages;
  const existing = messages.find(message => message.id === reply.assistantTurnId);
  if (existing) return existing.role !== "assistant" || existing.status !== "pending" ? messages
    : messages.map(message => message === existing ? { ...message, text: reply.text, streamed: true } : message);
  return [...messages, {
    id: reply.assistantTurnId, role: "assistant", text: reply.text,
    citations: [], citationLabels: [], status: "pending", streamed: true,
  }];
}

/** T02: label general answers when materials were in intent but no cite chips resolved. */
export function showsGeneralMaterialBadge(message: Pick<ChatMessageView, "role" | "citations" | "hadMaterialContext">): boolean {
  return message.role === "assistant"
    && Boolean(message.hadMaterialContext)
    && (message.citations?.length ?? 0) === 0;
}

export function messagesFromResume(
  resume: ConversationResume,
): { messages: ChatMessageView[]; historyTruncated: boolean } {
  const messages = resume.boundedHistory.map((turn, index) => {
    const citations = [...(turn.citations ?? [])];
    return {
      id: `resume-${index}-${turn.role}`,
      role: turn.role,
      text: turn.text,
      citations,
      citationLabels: citations.map((citation) => citation.label),
    };
  });
  return { messages, historyTruncated: resume.historyTruncated };
}

export function messagesFromTurns(turns: readonly TurnRecord[]): ChatMessageView[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    text: turn.text,
    citations: turn.citations,
    citationLabels: turn.citations.map((c) => c.label),
    status: turn.status,
    systemQuery: Boolean(turn.systemQuery),
    queryEvidenceLinks: turn.role === "assistant" ? queryEvidenceLinks(turn.systemQuery) : [],
    querySteps: turn.role === "assistant" ? querySteps(turn.systemQuery) : [],
  }));
}

/** Prefer persisted turns when present; else resume bounded history. */
export function resolveChatMessages(input: {
  resume: ConversationResume | null;
  turns: readonly TurnRecord[];
}): { messages: ChatMessageView[]; historyTruncated: boolean } {
  if (input.turns.length > 0) {
    return {
      messages: messagesFromTurns(input.turns),
      historyTruncated: input.resume?.historyTruncated ?? false,
    };
  }
  if (input.resume) {
    return messagesFromResume(input.resume);
  }
  return { messages: [], historyTruncated: false };
}

/** Only the current tab's temporary messages participate in temporary history. */
export function ephemeralHistoryFromMessages(messages: readonly ChatMessageView[]): EphemeralTurnInput["history"] {
  return messages.filter((message) => message.origin === "ephemeral").slice(-16).map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.provenanceId ? { provenanceId: message.provenanceId } : {}),
  }));
}
