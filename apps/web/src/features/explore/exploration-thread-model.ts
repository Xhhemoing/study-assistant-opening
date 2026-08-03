import type { AIRole, ChatTurn } from "@aistudy/contracts";
import type { ExplorationMessageResult } from "../../lib/data/types";
import { AI_ROLE_OPTIONS } from "../../lib/data/mock/mock-replies";

export function shouldSendOnEnter(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}

export function appendMessageTurns(
  turns: ChatTurn[],
  result: ExplorationMessageResult,
): ChatTurn[] {
  return result.aiTurn
    ? [...turns, result.userTurn, result.aiTurn]
    : [...turns, result.userTurn];
}

export function getRoleLabel(role: AIRole): string {
  return AI_ROLE_OPTIONS.find((option) => option.role === role)?.label ?? role;
}
