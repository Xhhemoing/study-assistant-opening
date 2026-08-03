import {
  type AIRole,
  type ChatTurn,
  type Exploration,
  type PracticeItem,
  type PromotionCandidate,
  type ReviewCard,
} from "@aistudy/contracts";
import { rankResults, type SearchDoc } from "@aistudy/domain";
import {
  newId,
  readDomain,
  writeDomain,
  type MockProviderState,
} from "./provider-state";
import type {
  CandidateStatus,
  DocumentLink,
  ExplorationDetail,
  GuidanceMode,
  SearchableDocument,
} from "../types";
import { craftMockReply } from "./mock-replies";

export function listExplorations(state: MockProviderState): Exploration[] {
  return readDomain<Exploration[]>(state, "explorations", [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getExploration(state: MockProviderState, id: string): ExplorationDetail | null {
  const exploration = readDomain<Exploration[]>(state, "explorations", []).find((item) => item.id === id);
  if (!exploration) return null;
  return {
    exploration,
    turns: readDomain<ChatTurn[]>(state, "chatTurns", []).filter((turn) => turn.explorationId === id),
    candidates: readDomain<PromotionCandidate[]>(state, "candidates", []).filter((candidate) => candidate.explorationId === id),
  };
}

export function createExploration(state: MockProviderState, title: string): Exploration {
  const now = state.now().toISOString();
  const exploration: Exploration = {
    id: newId(),
    ownerUserId: state.userId,
    title: title.trim() || "未命名探索",
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  writeDomain(state, "explorations", [...readDomain<Exploration[]>(state, "explorations", []), exploration]);
  return exploration;
}

export function sendExplorationMessage(
  state: MockProviderState,
  explorationId: string,
  content: string,
  role: AIRole,
): { userTurn: ChatTurn; aiTurn: ChatTurn | null; candidate: PromotionCandidate | null } {
  const detail = getExploration(state, explorationId);
  if (!detail) throw new Error("探索不存在");
  const now = state.now().toISOString();
  const userTurn: ChatTurn = {
    id: newId(),
    explorationId,
    author: "user",
    aiRole: null,
    content: content.trim() || "继续这个问题",
    simulated: false,
    createdAt: now,
  };
  const turns = [...readDomain<ChatTurn[]>(state, "chatTurns", []), userTurn];
  const userCount = turns.filter((turn) => turn.explorationId === explorationId && turn.author === "user").length;
  const aiTurn = role === "silent" ? null : {
    id: newId(),
    explorationId,
    author: "ai" as const,
    aiRole: role,
    content: craftMockReply(role, userTurn.content, userCount),
    simulated: true,
    createdAt: now,
  };
  if (aiTurn) turns.push(aiTurn);
  writeDomain(state, "chatTurns", turns);

  let candidate: PromotionCandidate | null = null;
  if (userCount % 2 === 0) {
    const kinds = ["note", "card", "question"] as const;
    const kind = kinds[(userCount / 2 - 1) % kinds.length] ?? "note";
    candidate = {
      id: newId(),
      explorationId,
      turnId: aiTurn?.id ?? userTurn.id,
      kind,
      title: `探索沉淀：${userTurn.content.slice(0, 24)}`,
      body: aiTurn?.content ?? userTurn.content,
      status: "pending",
      promotedTargetId: null,
      createdAt: now,
    };
    writeDomain(state, "candidates", [...readDomain<PromotionCandidate[]>(state, "candidates", []), candidate]);
  }
  const explorations = readDomain<Exploration[]>(state, "explorations", []);
  writeDomain(state, "explorations", explorations.map((item) => item.id === explorationId ? { ...item, updatedAt: now } : item));
  return { userTurn, aiTurn, candidate };
}

export function setCandidateStatus(
  state: MockProviderState,
  candidateId: string,
  status: CandidateStatus,
  promotedTargetId?: string | null,
): PromotionCandidate {
  const candidates = readDomain<PromotionCandidate[]>(state, "candidates", []);
  const current = candidates.find((candidate) => candidate.id === candidateId);
  if (!current) throw new Error("沉淀候选不存在");
  if (current.status !== "pending") return current;
  const next = { ...current, status, promotedTargetId: promotedTargetId ?? current.promotedTargetId };
  writeDomain(state, "candidates", candidates.map((candidate) => candidate.id === candidateId ? next : candidate));
  return next;
}

function documentBody(document: SearchableDocument): string {
  if (document.body) return document.body;
  return document.blocks?.map((block) => JSON.stringify(block.content)).join(" ") ?? "";
}

function buildSearchDocs(state: MockProviderState, remote: SearchableDocument[]): SearchDoc[] {
  const items = readDomain<PracticeItem[]>(state, "practiceItems", []);
  const cards = readDomain<ReviewCard[]>(state, "reviewCards", []);
  const explorations = readDomain<Exploration[]>(state, "explorations", []);
  const turns = readDomain<ChatTurn[]>(state, "chatTurns", []);
  const documentTags = readDomain<Record<string, string[]>>(state, "documentTags", {});
  return [
    ...remote.map((document) => ({ id: document.id, type: "document" as const, title: document.title, body: documentBody(document), tags: [...new Set([...(document.tags ?? []), ...(documentTags[document.id] ?? [])])] })),
    ...cards.filter((card) => !card.archived).map((card) => ({ id: card.id, type: "card" as const, title: card.front, body: card.back, tags: card.tags })),
    ...items.map((item) => ({ id: item.id, type: "practice" as const, title: item.stem, body: `${item.answer} ${item.hints.join(" ")}`, tags: [] })),
    ...explorations.map((exploration) => ({
      id: exploration.id,
      type: "exploration" as const,
      title: exploration.title,
      body: turns.filter((turn) => turn.explorationId === exploration.id).map((turn) => turn.content).join(" "),
      tags: [],
    })),
  ];
}

export async function searchAll(state: MockProviderState, query: string, limit = 20) {
  return rankResults(query, buildSearchDocs(state, await state.fetchDocuments()), limit);
}

export function getDocumentTags(state: MockProviderState, documentId: string): string[] {
  return readDomain<Record<string, string[]>>(state, "documentTags", {})[documentId] ?? [];
}

export function setDocumentTags(state: MockProviderState, documentId: string, tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized = tags.map((tag) => tag.normalize("NFKC").trim().replace(/\s+/gu, " ")).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const values = readDomain<Record<string, string[]>>(state, "documentTags", {});
  values[documentId] = normalized;
  writeDomain(state, "documentTags", values);
  return normalized;
}

export function indexDocumentLinks(state: MockProviderState, documentId: string, documentTitle: string, targetTitles: string[]): void {
  const existing = readDomain<DocumentLink[]>(state, "documentLinks", []).filter((link) => link.sourceDocumentId !== documentId);
  const now = state.now().toISOString();
  const links = [...new Set(targetTitles.map((title) => title.trim()).filter(Boolean))].map((targetTitle) => ({
    sourceDocumentId: documentId,
    sourceTitle: documentTitle,
    targetTitle,
    createdAt: now,
  }));
  writeDomain(state, "documentLinks", [...existing, ...links]);
}

export function listBacklinks(state: MockProviderState, targetTitle: string): DocumentLink[] {
  return readDomain<DocumentLink[]>(state, "documentLinks", [])
    .filter((link) => link.targetTitle.toLowerCase() === targetTitle.trim().toLowerCase())
    .sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle));
}

export function getGuidanceMode(state: MockProviderState): GuidanceMode {
  return readDomain<GuidanceMode>(state, "guidance", "balanced");
}

export function setGuidanceMode(state: MockProviderState, mode: GuidanceMode): GuidanceMode {
  writeDomain(state, "guidance", mode);
  return mode;
}
