import { describe, expect, it } from "vitest";
import {
  ankiExportRequestSchema,
  ankiExportResponseSchema,
  markdownExportRequestSchema,
  markdownExportResponseSchema,
} from "./portability";

const documentId = "11111111-1111-4111-8111-111111111111";
const blockId = "22222222-2222-4222-8222-222222222222";

describe("markdown portability contracts", () => {
  it("accepts an optional document id and strips a client workspace id", () => {
    expect(markdownExportRequestSchema.parse({})).toEqual({});
    expect(markdownExportRequestSchema.parse({ documentId })).toEqual({ documentId });
    expect(
      markdownExportRequestSchema.parse({
        documentId,
        workspaceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({ documentId });
  });

  it("requires markdown, a traceable manifest, and a loss report that never claims lossless", () => {
    const parsed = markdownExportResponseSchema.parse({
      format: "markdown",
      markdown: "# Note\n",
      manifest: {
        attachments: [
          {
            id: "att-1",
            filename: "scan.png",
            mediaType: "image/png",
            href: "attachments/scan.png",
          },
        ],
        blockIdentities: [{ blockId, marker: `aistudy-block:${blockId}` }],
        sourceFiles: [{ path: "origin/notes.md", mediaType: "text/markdown" }],
      },
      lossReport: {
        claimedLossless: false,
        losses: [
          {
            code: "unsupported-block",
            feature: "callout",
            message: "Callout blocks are not expressible in Markdown.",
            blockId,
            documentId,
          },
        ],
      },
    });
    expect(parsed.format).toBe("markdown");
    expect(parsed.lossReport.claimedLossless).toBe(false);
    expect(parsed.manifest.blockIdentities[0]?.marker).toContain(blockId);

    expect(() =>
      markdownExportResponseSchema.parse({
        format: "markdown",
        markdown: "# Note\n",
        manifest: { attachments: [], blockIdentities: [], sourceFiles: [] },
        lossReport: { claimedLossless: true, losses: [] },
      }),
    ).toThrow();
  });
});

describe("anki portability contracts", () => {
  const cardId = "44444444-4444-4444-8444-444444444444";

  it("accepts an optional card id and strips a client workspace id", () => {
    expect(ankiExportRequestSchema.parse({})).toEqual({});
    expect(ankiExportRequestSchema.parse({ cardId })).toEqual({ cardId });
    expect(
      ankiExportRequestSchema.parse({
        cardId,
        workspaceId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({ cardId });
  });

  it("requires an Anki projection, media manifest, scheduling fields, and a loss report that never claims lossless", () => {
    const parsed = ankiExportResponseSchema.parse({
      format: "anki",
      deckName: "AIstudy",
      notes: [
        {
          id: cardId,
          model: "basic",
          fields: { Front: "导数", Back: "极限定义", Source: "aistudy://document/11111111-1111-4111-8111-111111111111" },
          tags: ["高数"],
        },
      ],
      scheduling: [
        {
          cardId,
          dueAt: "2026-08-16T00:00:00.000Z",
          intervalDays: 1,
          ease: 2.5,
          factor: 2500,
          reps: 1,
          lapses: 0,
        },
      ],
      ankiTsv: "Front\tBack\tSource\tTags\n",
      manifest: {
        media: [
          { id: "media-1", filename: "graph.png", mediaType: "image/png", href: "media/graph.png" },
        ],
      },
      lossReport: {
        claimedLossless: false,
        losses: [
          {
            code: "review-history",
            feature: "review-history",
            message: "Append-only review events are omitted from the Anki projection.",
            cardId,
          },
        ],
      },
    });
    expect(parsed.format).toBe("anki");
    expect(parsed.lossReport.claimedLossless).toBe(false);
    expect(parsed.scheduling[0]?.factor).toBe(2500);

    expect(() =>
      ankiExportResponseSchema.parse({
        format: "anki",
        deckName: "AIstudy",
        notes: [],
        scheduling: [],
        ankiTsv: "",
        manifest: { media: [] },
        lossReport: { claimedLossless: true, losses: [] },
      }),
    ).toThrow();
  });
});
