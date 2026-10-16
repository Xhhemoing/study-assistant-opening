import "server-only";
import type { Sql } from "postgres";
import { loadFeatureSwitches } from "@aistudy/config";
import { suggestionFeedbackInputSchema, type Scope } from "@aistudy/contracts";
import { recordOpeningSuggestionFeedback } from "@aistudy/database";
import { ApiError } from "../../auth/service";

export async function submitOpeningSuggestionFeedback(sql: Sql, scope: Scope, raw: unknown) {
  if (!loadFeatureSwitches().adaptivePlanning) throw new ApiError("NOT_FOUND", "建议反馈尚未启用。", 404);
  return recordOpeningSuggestionFeedback(sql, scope, suggestionFeedbackInputSchema.parse(raw));
}
