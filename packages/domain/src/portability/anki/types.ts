import type { AttachmentManifestEntry, LossEntry } from "@aistudy/contracts";

export type AnkiSourceScheduling = {
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
};

export type AnkiUnsupportedFlags = {
  courseRequirements?: boolean;
  explorationProvenance?: boolean;
  relations?: boolean;
  reviewHistory?: boolean;
};

export type AnkiSourceCard = {
  id: string;
  front: string;
  back: string;
  tags: string[];
  sourceDocumentId: string | null;
  media?: AttachmentManifestEntry[];
  scheduling?: AnkiSourceScheduling | null;
  unsupported?: AnkiUnsupportedFlags;
};

export type AnkiDeckInput = {
  deckName?: string;
  cards: AnkiSourceCard[];
};

export function sourceLink(documentId: string | null): string {
  return documentId ? `aistudy://document/${documentId}` : "";
}

export function lossFor(code: string, feature: string, message: string, cardId: string): LossEntry {
  return { code, feature, message, cardId };
}
