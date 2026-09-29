import type { SnippetCreateInput, SnippetCreateResponse } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";
import type { ChatMessageView } from "./message-model";

export function snippetSaveAvailability(message: ChatMessageView): "hidden" | "missing_provenance" | "available" {
  if (message.origin !== "ephemeral" || (message.status && message.status !== "complete")) return "hidden";
  return message.provenanceId ? "available" : "missing_provenance";
}

export function prepareSnippetDraft(message: ChatMessageView, selectedText?: string): SnippetCreateInput | null {
  if (snippetSaveAvailability(message) !== "available" || !message.provenanceId) return null;
  const text = selectedText?.trim() ? selectedText : message.text;
  return { title: text.trim().split(/\r?\n/, 1)[0]?.slice(0, 80) || "对话片段", text, provenanceId: message.provenanceId };
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
