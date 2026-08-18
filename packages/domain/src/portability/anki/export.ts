import type { AnkiExportResponse, AnkiNote, AnkiScheduling, LossEntry } from "@aistudy/contracts";
import { mediaFromCardText } from "./media";
import { serializeAnkiTsv } from "./tsv";
import { lossFor, sourceLink, type AnkiDeckInput, type AnkiSourceCard } from "./types";

export function exportAnkiDeck(input: AnkiDeckInput): Omit<AnkiExportResponse, "format"> {
  const notes: AnkiNote[] = [];
  const scheduling: AnkiScheduling[] = [];
  const media = [];
  const losses: LossEntry[] = [];

  for (const card of input.cards) {
    const note = toNote(card);
    notes.push(note);
    media.push(...(card.media ?? mediaFromCardText(card.id, card.front, card.back)));
    if (card.scheduling) {
      scheduling.push({
        cardId: card.id,
        dueAt: card.scheduling.dueAt,
        intervalDays: card.scheduling.intervalDays,
        ease: card.scheduling.ease,
        factor: Math.round(card.scheduling.ease * 1000),
        reps: card.scheduling.reps,
        lapses: card.scheduling.lapses,
      });
    }
    losses.push(...unsupportedLosses(card));
  }

  return {
    deckName: input.deckName ?? "AIstudy",
    notes,
    scheduling,
    ankiTsv: serializeAnkiTsv(notes),
    manifest: { media },
    lossReport: { claimedLossless: false, losses },
  };
}

function toNote(card: AnkiSourceCard): AnkiNote {
  return {
    id: card.id,
    model: "basic",
    fields: {
      Front: card.front,
      Back: card.back,
      Source: sourceLink(card.sourceDocumentId),
    },
    tags: card.tags,
  };
}

function unsupportedLosses(card: AnkiSourceCard): LossEntry[] {
  const flags = card.unsupported ?? {};
  const losses: LossEntry[] = [];
  if (flags.courseRequirements) {
    losses.push(lossFor(
      "course-requirements",
      "course-requirements",
      "Course requirement profiles are omitted from the Anki projection.",
      card.id,
    ));
  }
  if (flags.explorationProvenance) {
    losses.push(lossFor(
      "exploration-provenance",
      "exploration-provenance",
      "Exploration provenance is omitted from the Anki projection.",
      card.id,
    ));
  }
  if (flags.relations) {
    losses.push(lossFor(
      "relations",
      "relations",
      "Document relations are omitted from the Anki projection.",
      card.id,
    ));
  }
  if (flags.reviewHistory) {
    losses.push(lossFor(
      "review-history",
      "review-history",
      "Append-only review events are omitted from the Anki projection.",
      card.id,
    ));
  }
  return losses;
}
