import type { TurnRecord } from "@aistudy/contracts";
import type { StudyConversationContext } from "./study-conversation-context";

const identityFields = ["courseId", "activityId", "blockId", "contentVersion", "attemptId", "itemVersionId", "kcMappingVersion", "sourceId", "sourceVersion", "page", "chunkId"] as const;
const mismatch = "这段对话与原来的学习内容不一致。请回到原题或资料重新打开提问。";

/** The caller owns and has decoded these turns. Query metadata never establishes a saved binding. */
export function resolveBoundConversationContext(turns: readonly TurnRecord[], requested?: StudyConversationContext): { context?: StudyConversationContext; error?: string } {
  // A verified system-query receipt is not evidence about a learning item.
  const questions = turns.filter(turn => turn.role === "user" && !turn.systemQuery);
  if (!questions.length) return requested ? { context: requested } : {};
  const anchor = [...questions].reverse().find(turn => turn.contextAnchor)?.contextAnchor;
  if (!anchor) return identityFields.some(key => requested?.[key] !== undefined) ? { error: mismatch } : {};
  if (questions.some(turn => identityFields.some(key => (turn.contextAnchor?.[key] ?? undefined) !== (anchor[key] ?? undefined)))) return { error: mismatch };
  if (identityFields.some(key => requested?.[key] !== undefined && requested[key] !== (anchor[key] ?? undefined))) return { error: mismatch };
  const context: StudyConversationContext = Object.fromEntries(Object.entries(anchor).filter(([, value]) => value != null));
  for (const key of ["label", "returnTo", "fragment"] as const) if (requested?.[key] !== undefined) context[key] = requested[key];
  return { context };
}
