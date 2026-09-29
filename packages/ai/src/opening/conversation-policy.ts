import { ephemeralTurnInputSchema, uuidSchema, type ProviderOutput, type TutorMode } from "@aistudy/contracts";

export const EPHEMERAL_HISTORY_MAX_TURNS = 16;
export const EPHEMERAL_HISTORY_MAX_CHARS = 24_000;

export class ConversationPolicyError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ConversationPolicyError";
  }
}

/** Listening never proposes a task. Only think-together may. */
export function canProposeTask(mode: TutorMode): boolean {
  return mode === "think_together";
}

export function assertEphemeralInput(input: unknown): void {
  const parsed = ephemeralTurnInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConversationPolicyError("ephemeral input is invalid");
  }
  const { text, sourceIds, history } = parsed.data;
  if (text.trim().length === 0) {
    throw new ConversationPolicyError("ephemeral text is empty");
  }
  if (history.length > EPHEMERAL_HISTORY_MAX_TURNS) {
    throw new ConversationPolicyError(`ephemeral history exceeds ${EPHEMERAL_HISTORY_MAX_TURNS} turns`);
  }
  const characters = history.reduce((sum, turn) => sum + turn.text.length, 0);
  if (characters > EPHEMERAL_HISTORY_MAX_CHARS) {
    throw new ConversationPolicyError(`ephemeral history exceeds ${EPHEMERAL_HISTORY_MAX_CHARS} characters`);
  }
  for (const turn of history) {
    if ((turn.role !== "user" && turn.role !== "assistant") || turn.text.trim().length === 0) {
      throw new ConversationPolicyError("ephemeral history turn is invalid");
    }
    if (Object.keys(turn).some((key) => key !== "role" && key !== "text" && key !== "provenanceId")) {
      throw new ConversationPolicyError("ephemeral history turn has extra fields");
    }
  }
  for (const sourceId of sourceIds) {
    if (!uuidSchema.safeParse(sourceId).success) {
      throw new ConversationPolicyError("ephemeral source id is invalid");
    }
  }
}

/** Ephemeral responses never carry or persist model candidates. */
export function stripEphemeralCandidates(output: ProviderOutput): ProviderOutput {
  return { ...output, candidates: [] };
}
