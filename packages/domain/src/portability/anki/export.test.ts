import { describe, expect, it } from "vitest";
import { exportAnkiDeck } from "./export";

const CARD_ID = "44444444-4444-4444-8444-444444444444";
const DOC_ID = "11111111-1111-4111-8111-111111111111";
const DUE = "2026-08-16T00:00:00.000Z";

function sampleCard() {
  return {
    id: CARD_ID,
    front: "导数 ![图](media/graph.png)",
    back: "极限定义",
    tags: ["高数"],
    sourceDocumentId: DOC_ID,
    scheduling: {
      dueAt: DUE,
      intervalDays: 1,
      ease: 2.5,
      reps: 1,
      lapses: 0,
    },
    unsupported: {
      courseRequirements: true,
      explorationProvenance: true,
      relations: true,
      reviewHistory: true,
    },
  };
}

describe("anki projection export", () => {
  it("projects card content, media, tags, source links, and supported scheduling fields", () => {
    const exported = exportAnkiDeck({ cards: [sampleCard()] });
    expect(exported.lossReport.claimedLossless).toBe(false);
    expect(exported.deckName).toBe("AIstudy");
    expect(exported.notes).toEqual([
      {
        id: CARD_ID,
        model: "basic",
        fields: {
          Front: "导数 ![图](media/graph.png)",
          Back: "极限定义",
          Source: `aistudy://document/${DOC_ID}`,
        },
        tags: ["高数"],
      },
    ]);
    expect(exported.scheduling).toEqual([
      {
        cardId: CARD_ID,
        dueAt: DUE,
        intervalDays: 1,
        ease: 2.5,
        factor: 2500,
        reps: 1,
        lapses: 0,
      },
    ]);
    expect(exported.manifest.media).toEqual([
      {
        id: CARD_ID,
        filename: "graph.png",
        mediaType: "application/octet-stream",
        href: "media/graph.png",
      },
    ]);
    expect(exported.ankiTsv).toContain("导数 ![图](media/graph.png)");
    expect(exported.ankiTsv).toContain("极限定义");
    expect(exported.ankiTsv).toContain("高数");
    expect(exported.ankiTsv).toContain(`aistudy://document/${DOC_ID}`);
  });

  it("reports course requirements, exploration provenance, relations, and review history as losses", () => {
    const exported = exportAnkiDeck({ cards: [sampleCard()] });
    expect(exported.lossReport.claimedLossless).toBe(false);
    expect(exported.lossReport.losses.map((loss) => loss.code).sort()).toEqual([
      "course-requirements",
      "exploration-provenance",
      "relations",
      "review-history",
    ]);
    expect(exported.lossReport.losses.every((loss) => loss.cardId === CARD_ID)).toBe(true);
  });
});
