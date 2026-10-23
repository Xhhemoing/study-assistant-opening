import { z } from "zod";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { snippetCreateInputSchema, type SnippetCreateInput, type SnippetCreateResponse } from "@aistudy/contracts";
import { createSnippetSaveAttempt, type SnippetSaveResult } from "./save-snippet";

const schema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["pending", "unknown"]), input: snippetCreateInputSchema }).strict(),
  z.object({ status: z.literal("saved"), input: snippetCreateInputSchema, documentId: z.string().uuid() }).strict(),
]);
export type SnippetSaveReceipt = z.infer<typeof schema>;
const memory = new Map<string, SnippetSaveReceipt>();
const flights = new Map<string, Promise<SnippetSaveResult>>();
const listeners = new Map<string, Set<() => void>>();
const storageKey = (identity: string) => {
  const namespace = getVerifiedSessionNamespace();
  if (!namespace) throw new Error("请先确认当前登录会话，再保存笔记。");
  return `opening:snippet-save:v1:${encodeURIComponent(namespace)}:${identity}`;
};
const publish = (identity: string) => listeners.get(identity)?.forEach(listener => listener());

export function snippetSaveIdentity(input: SnippetCreateInput): string {
  return JSON.stringify([input.savedTurnId ? ["saved", input.savedTurnId] : ["ephemeral", input.provenanceId], input.title, input.text]);
}
export function readSnippetSaveReceipt(identity: string): SnippetSaveReceipt | null {
  return readAt(storageKey(identity));
}
function readAt(key: string): SnippetSaveReceipt | null {
  const cached = memory.get(key);
  if (cached) return cached;
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = schema.parse(JSON.parse(raw));
  const receipt: SnippetSaveReceipt = parsed.status === "pending" && !flights.has(key) ? { ...parsed, status: "unknown" } : parsed;
  memory.set(key, receipt); return receipt;
}
export function subscribeSnippetSave(identity: string, listener: () => void) {
  let key: string;
  try { key = storageKey(identity); } catch { return () => undefined; }
  const entries = listeners.get(key) ?? new Set<() => void>();
  entries.add(listener); listeners.set(key, entries);
  return () => { entries.delete(listener); if (!entries.size) listeners.delete(key); };
}
function write(key: string, receipt: SnippetSaveReceipt, beforeRequest = false) {
  if (beforeRequest) sessionStorage.setItem(key, JSON.stringify(receipt));
  memory.set(key, receipt); publish(key);
  if (!beforeRequest) {
    try { sessionStorage.setItem(key, JSON.stringify(receipt)); }
    catch { /* The durable pending receipt still blocks an uncertain new write after reload. */ }
  }
}
/** Starting another note is explicit and allowed only after the prior write is known saved. */
export function startAnotherSnippetSave(identity: string) {
  const key = storageKey(identity);
  if (readAt(key)?.status !== "saved") return;
  sessionStorage.removeItem(key); memory.delete(key); publish(key);
}

/** The snippets endpoint has no idempotent retry. Unknown results retain the exact input and block a new POST. */
export function saveSnippetWithReceipt(identity: string, input: SnippetCreateInput, create: (input: SnippetCreateInput) => Promise<SnippetCreateResponse>): Promise<SnippetSaveResult> {
  const key = storageKey(identity);
  const pending = flights.get(key);
  if (pending) return pending;
  const receipt = readAt(key);
  if (receipt?.status === "saved") return Promise.resolve({ kind: "saved", documentId: receipt.documentId });
  if (receipt) return Promise.resolve({ kind: "unknown" });
  write(key, { status: "pending", input: snippetCreateInputSchema.parse(input) }, true);
  const operation = createSnippetSaveAttempt(create).confirm(input).then(result => {
    if (!result) throw new Error("片段保存结果暂时无法读取，请先检查笔记列表。");
    if (result.kind === "failed") {
      sessionStorage.removeItem(key); memory.delete(key); publish(key);
    } else write(key, result.kind === "saved" ? { status: "saved", input, documentId: result.documentId } : { status: "unknown", input });
    return result;
  }).finally(() => { flights.delete(key); });
  flights.set(key, operation); return operation;
}
