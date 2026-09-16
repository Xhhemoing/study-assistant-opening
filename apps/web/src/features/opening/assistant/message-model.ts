import type { ConversationResume, TurnRecord } from "@aistudy/contracts";

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citationLabels: string[];
  status?: TurnRecord["status"];
};

export function messagesFromResume(
  resume: ConversationResume,
): { messages: ChatMessageView[]; historyTruncated: boolean } {
  const messages = resume.boundedHistory.map((turn, index) => ({
    id: `resume-${index}-${turn.role}`,
    role: turn.role,
    text: turn.text,
    citationLabels: [] as string[],
  }));
  return { messages, historyTruncated: resume.historyTruncated };
}

export function messagesFromTurns(turns: readonly TurnRecord[]): ChatMessageView[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    text: turn.text,
    citationLabels: turn.citations.map((c) => c.label),
    status: turn.status,
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
