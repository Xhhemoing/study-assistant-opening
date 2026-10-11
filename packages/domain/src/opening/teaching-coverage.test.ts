import { describe, expect, it } from "vitest";
import {
  anchorKey,
  buildCoverageTable,
  lexicalOverlapScore,
  markConflict,
  mergeCoverageStatus,
  type CoverageRow,
  type SourceAnchor,
} from "./teaching-coverage";

const a = (
  sourceId: string,
  chunkId: string,
  version = 1,
  page: number | null = 1,
): SourceAnchor => ({
  sourceId,
  sourceVersion: version,
  chunkId,
  page,
  slideLabel: null,
  startMs: null,
});

describe("teaching-coverage", () => {
  it("E1: same page different sourceId → distinct anchorKeys; never page-alone", () => {
    const left = a("SRC-RN-01", "chunk-a", 1, 3);
    const right = a("SRC-RN-02", "chunk-b", 1, 3);
    expect(anchorKey(left)).toBe("SRC-RN-01@1#chunk-a");
    expect(anchorKey(right)).toBe("SRC-RN-02@1#chunk-b");
    expect(anchorKey(left)).not.toBe(anchorKey(right));
    // page alone must not be used as identity
    expect(anchorKey(left)).not.toBe(`page:${left.page}`);
    expect(anchorKey(left).includes(left.chunkId)).toBe(true);
    expect(anchorKey(left).includes(left.sourceId)).toBe(true);
  });

  it("E2: overlong slideLabel preserved on identity fields", () => {
    const long = "S".repeat(200);
    const anchor: SourceAnchor = {
      sourceId: "SRC-RN-01",
      sourceVersion: 2,
      chunkId: "c-long",
      page: 9,
      slideLabel: long,
      startMs: 1200,
    };
    expect(anchorKey(anchor)).toBe("SRC-RN-01@2#c-long");
    expect(anchor.slideLabel).toBe(long);
    expect(anchor.startMs).toBe(1200);
    expect(anchor.page).toBe(9);
  });

  it("builds covered / partial / uncovered rows from lexical overlap", () => {
    const anchors = [
      a("SRC-A", "c1", 1, 1),
      a("SRC-B", "c2", 1, 1),
    ];
    const chunkTexts = new Map<string, string>([
      [anchorKey(anchors[0]!), "nullspace rank nullity theorem"],
      [anchorKey(anchors[1]!), "unrelated weather report"],
    ]);
    const rows = buildCoverageTable({
      conditions: [
        {
          conditionId: "G1#sc-0",
          goalId: "G1",
          statement: "Explain rank-nullity and nullspace",
          linkedSourceIds: ["SRC-A", "SRC-B"],
        },
        {
          conditionId: "G1#sc-1",
          statement: "Define orthogonal complement",
          linkedSourceIds: ["SRC-A", "SRC-B"],
        },
        {
          conditionId: "G2#sc-0",
          statement: "Something with no materials",
          linkedSourceIds: ["SRC-MISSING"],
        },
      ],
      anchors,
      chunkTexts,
    });
    expect(rows[0]!.status).toBe("covered");
    expect(rows[0]!.sourceAnchors.map(anchorKey)).toEqual([anchorKey(anchors[0]!)]);
    expect(rows[1]!.status).toBe("partial");
    expect(rows[1]!.notes).toMatch(/zero lexical overlap/i);
    expect(rows[2]!.status).toBe("uncovered");
    expect(rows[2]!.sourceAnchors).toEqual([]);
  });

  it("conflicts option forces conflict; markConflict helper works", () => {
    const anchors = [a("SRC-A", "c1")];
    const chunkTexts = new Map([[anchorKey(anchors[0]!), "alpha beta"]]);
    const [row] = buildCoverageTable({
      conditions: [{ conditionId: "c-conflict", statement: "alpha" }],
      anchors,
      chunkTexts,
      conflicts: ["c-conflict"],
    });
    expect(row!.status).toBe("conflict");
    const marked = markConflict({
      conditionId: "x",
      statement: "y",
      sourceAnchors: anchors,
      status: "covered",
    });
    expect(marked.status).toBe("conflict");
  });

  it("mergeCoverageStatus is worst-wins", () => {
    const base: CoverageRow = {
      conditionId: "c",
      statement: "s",
      sourceAnchors: [],
      status: "covered",
    };
    expect(mergeCoverageStatus([])).toBe("uncovered");
    expect(
      mergeCoverageStatus([
        { ...base, status: "covered" },
        { ...base, status: "partial" },
      ]),
    ).toBe("partial");
    expect(
      mergeCoverageStatus([
        { ...base, status: "partial" },
        { ...base, status: "uncovered" },
      ]),
    ).toBe("uncovered");
    expect(
      mergeCoverageStatus([
        { ...base, status: "uncovered" },
        { ...base, status: "conflict" },
      ]),
    ).toBe("conflict");
  });

  it("empty text yields zero overlap (image-only honesty)", () => {
    expect(lexicalOverlapScore("rank nullity", "")).toBe(0);
    expect(lexicalOverlapScore("rank nullity", "   ")).toBe(0);
    expect(lexicalOverlapScore("rank", "the rank of A")).toBeGreaterThan(0);
  });

  it("AN-RN-08: coverage API has no mastery percent fields", () => {
    const row = buildCoverageTable({
      conditions: [{ conditionId: "c", statement: "hello world" }],
      anchors: [a("S", "c1")],
      chunkTexts: new Map([["S@1#c1", "hello world"]]),
    })[0]!;
    const keys = Object.keys(row);
    expect(keys.some((k) => /mastery|confidence|percent|%/i.test(k))).toBe(false);
    expect(JSON.stringify(row)).not.toMatch(/mastery|confidencePercent/i);
  });
});
