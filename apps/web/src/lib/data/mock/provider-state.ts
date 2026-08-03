import type {
  AttemptEvent,
  ChatTurn,
  Exploration,
  PracticeItem,
  PromotionCandidate,
  ReviewCard,
  ReviewState,
  StudyGoal,
  TodayPlan,
} from "@aistudy/contracts";
import { buildSeedBundle } from "./seeds";
import {
  loadDomain,
  mockKey,
  resetDomains,
  saveDomain,
  type StorageLike,
} from "./storage";
import type { MockProviderOptions, SearchableDocument } from "../types";

export interface PlanOverlay {
  status?: TodayPlan["tasks"][number]["status"];
  locked?: boolean;
}

export interface PlanSnapshot {
  goalId: string;
  overlays: Record<string, PlanOverlay>;
  lastPlan: TodayPlan | null;
}

export interface MockProviderState {
  userId: string;
  storage: StorageLike;
  fetchDocuments: () => Promise<SearchableDocument[]>;
  now: () => Date;
}

export const MOCK_DOMAINS = [
  "goals",
  "practiceItems",
  "attemptEvents",
  "reviewCards",
  "reviewStates",
  "explorations",
  "chatTurns",
  "candidates",
  "plans",
  "corrections",
  "documentTags",
  "documentLinks",
  "guidance",
] as const;

export function createProviderState(options: MockProviderOptions): MockProviderState {
  return {
    userId: options.userId,
    storage: options.storage,
    fetchDocuments: options.fetchDocuments ?? (async () => []),
    now: () => new Date(options.now instanceof Function ? options.now() : options.now ?? new Date()),
  };
}

export function ensureSeed(state: MockProviderState): void {
  const existing = loadDomain<unknown>(state.storage, state.userId, "goals", null);
  if (Array.isArray(existing)) return;
  if (existing !== null) state.storage.removeItem(mockKey(state.userId, "goals"));
  const bundle = buildSeedBundle(state.userId, state.now());
  saveDomain(state.storage, state.userId, "goals", [bundle.goal]);
  saveDomain(state.storage, state.userId, "practiceItems", bundle.practiceItems);
  saveDomain(state.storage, state.userId, "attemptEvents", bundle.attemptEvents);
  saveDomain(state.storage, state.userId, "reviewCards", bundle.reviewCards);
  saveDomain(state.storage, state.userId, "reviewStates", bundle.reviewStates);
  saveDomain(state.storage, state.userId, "explorations", [bundle.exploration]);
  saveDomain(state.storage, state.userId, "chatTurns", bundle.chatTurns);
  saveDomain(state.storage, state.userId, "candidates", bundle.candidates);
  saveDomain(state.storage, state.userId, "plans", {});
  saveDomain(state.storage, state.userId, "corrections", []);
  saveDomain(state.storage, state.userId, "documentTags", {});
  saveDomain(state.storage, state.userId, "documentLinks", []);
  saveDomain(state.storage, state.userId, "guidance", "balanced");
}

export function readDomain<T>(state: MockProviderState, domain: string, fallback: T): T {
  ensureSeed(state);
  return loadDomain(state.storage, state.userId, domain, fallback);
}

export function writeDomain<T>(state: MockProviderState, domain: string, value: T): void {
  saveDomain(state.storage, state.userId, domain, value);
}

export function readPlanSnapshots(state: MockProviderState): Record<string, PlanSnapshot> {
  return readDomain(state, "plans", {} as Record<string, PlanSnapshot>);
}

export function writePlanSnapshots(
  state: MockProviderState,
  snapshots: Record<string, PlanSnapshot>,
): void {
  writeDomain(state, "plans", snapshots);
}

export function newId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const segment = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${segment()}-${segment().slice(0, 4)}-4${segment().slice(1, 4)}-8${segment().slice(1, 4)}-${segment()}${segment().slice(0, 4)}`;
}

export function todayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function pause(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export function resetState(state: MockProviderState): void {
  resetDomains(state.storage, state.userId, [...MOCK_DOMAINS]);
  ensureSeed(state);
}

export function rawStorageKey(state: MockProviderState, domain: string): string {
  return mockKey(state.userId, domain);
}

export type StoredRecords = {
  goals: StudyGoal[];
  practiceItems: PracticeItem[];
  attemptEvents: AttemptEvent[];
  reviewCards: ReviewCard[];
  reviewStates: ReviewState[];
  explorations: Exploration[];
  chatTurns: ChatTurn[];
  candidates: PromotionCandidate[];
};
