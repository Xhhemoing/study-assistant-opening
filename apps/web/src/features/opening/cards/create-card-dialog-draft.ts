import { createCardRequestSchema } from "@aistudy/contracts";
import { z } from "zod";

const receiptSchema = z.object({
  input: createCardRequestSchema.extend({ cardId: z.string().uuid() }),
  status: z.enum(["editing", "pending", "unknown", "saved"]),
  stage: z.enum(["source", "card"]).default("card"),
});
export type CardDraftReceipt = z.infer<typeof receiptSchema>;
const memory = new Map<string, CardDraftReceipt>();
const flights = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const publish = (identity: string) => listeners.get(identity)?.forEach(listener => listener());
export const isCardDraftPending = (identity: string) => flights.has(identity);
export function setCardDraftPending(identity: string, pending: boolean) {
  if (pending) flights.add(identity); else flights.delete(identity);
  publish(identity);
}
export function subscribeCardDraftReceipt(identity: string, listener: () => void) {
  const entries = listeners.get(identity) ?? new Set<() => void>();
  entries.add(listener); listeners.set(identity, entries);
  return () => { entries.delete(listener); if (!entries.size) listeners.delete(identity); };
}
const storageKey = (identity: string) => `opening:card-draft:v1:${identity}`;

/** A pending or unknown receipt keeps the exact visible intent across closing and reopening. */
export function readCardDraftReceipt(identity: string): CardDraftReceipt | null {
  const cached = memory.get(identity);
  if (cached) return cached;
  const raw = sessionStorage.getItem(storageKey(identity));
  if (!raw) return null;
  const receipt = receiptSchema.parse(JSON.parse(raw));
  memory.set(identity, receipt);
  return receipt;
}

/** The request identity must be durable before crossing the write boundary. */
export function writeCardDraftReceipt(identity: string, receipt: z.input<typeof receiptSchema>): void {
  const value = receiptSchema.parse(receipt);
  if (value.status === "pending") sessionStorage.setItem(storageKey(identity), JSON.stringify(value));
  memory.set(identity, value); publish(identity);
  if (value.status !== "pending") {
    try { sessionStorage.setItem(storageKey(identity), JSON.stringify(value)); }
    catch { /* Keep the known result in memory; the durable pending input still prevents a new identity after reload. */ }
  }
}

export function clearCardDraftReceipt(identity: string): void {
  sessionStorage.removeItem(storageKey(identity));
  memory.delete(identity); publish(identity);
}
