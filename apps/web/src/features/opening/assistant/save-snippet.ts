import type { SnippetCreateInput, SnippetCreateResponse } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";
import type { ChatMessageView } from "./message-model";

export function snippetSaveAvailability(message: ChatMessageView): "hidden" | "missing_provenance" | "query_not_supported" | "available" {
  if (message.origin !== "ephemeral" || (message.status && message.status !== "complete")) return "hidden";
  if (message.systemQuery) return "query_not_supported";
  return message.provenanceId ? "available" : "missing_provenance";
}

/** What the user selected; `unmapped` means a selection existed but the whole answer is used instead. */
export type SelectedExcerpt = { text: string } | { unmapped: true };

export const UNMAPPED_SELECTION_NOTICE = "无法精确定位选区，已改为保存整段回答，可在下方修改。";

/** API input plus a page-only notice; dialogs send `input`, never the whole draft. */
export type SnippetDraft = { input: SnippetCreateInput; notice?: string };

export function prepareSnippetDraft(message: ChatMessageView, selection?: SelectedExcerpt): SnippetDraft | null {
  if (snippetSaveAvailability(message) !== "available" || !message.provenanceId) return null;
  const selected = selection && "text" in selection && selection.text.trim() ? selection.text : undefined;
  const text = selected ?? message.text;
  const input = { title: text.trim().split(/\r?\n/, 1)[0]?.slice(0, 80) || "对话片段", text, provenanceId: message.provenanceId };
  return selection && "unmapped" in selection ? { input, notice: UNMAPPED_SELECTION_NOTICE } : { input };
}

export type SnippetSaveResult =
  | { kind: "saved"; documentId: string }
  | { kind: "failed"; message: string }
  | { kind: "unknown" };

/** One explicit confirmation at a time; an uncertain write is never retried. */
export function createSnippetSaveAttempt(create: (input: SnippetCreateInput) => Promise<SnippetCreateResponse>) {
  let inFlight = false;
  let settled = false;
  return {
    async confirm(input: SnippetCreateInput): Promise<SnippetSaveResult | null> {
      if (inFlight || settled) return null;
      inFlight = true;
      try {
        const result = await create(input);
        settled = true;
        return { kind: "saved", documentId: result.documentId };
      } catch (error) {
        if (error instanceof OpeningApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          return { kind: "failed", message: error.message };
        }
        settled = true;
        return { kind: "unknown" };
      } finally {
        inFlight = false;
      }
    },
  };
}
