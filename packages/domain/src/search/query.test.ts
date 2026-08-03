import { describe, expect, it } from "vitest";
import { rankResults, type SearchDoc } from "./query";

function doc(partial: Partial<SearchDoc> & { id: string; title: string }): SearchDoc {
  return { type: "document", body: "", tags: [], ...partial };
}

describe("rankResults", () => {
  it("ranks title matches above body matches", () => {
    const hits = rankResults("导数", [
      doc({ id: "b", title: "复习记录", body: "今天复习了导数的定义" }),
      doc({ id: "a", title: "导数笔记", body: "" }),
    ]);
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(hits[0].score).toBe(3);
    expect(hits[1].score).toBe(1);
  });

  it("scores tag matches and sums per token", () => {
    const hits = rankResults("高数", [
      doc({ id: "t", title: "杂记", tags: ["高数上"], body: "高数" }),
    ]);
    expect(hits[0].score).toBe(3); // tag 2 + body 1
  });

  it("normalizes full-width query text before matching tags", () => {
    const hits = rankResults(" ＴＯＰＩＣ ", [
      doc({ id: "tagged", title: "专题笔记", tags: ["TOPIC"] }),
    ]);

    expect(hits[0]?.id).toBe("tagged");
  });

  it("returns [] for an empty query and drops zero-score docs", () => {
    expect(rankResults("   ", [doc({ id: "a", title: "导数" })])).toEqual([]);
    const hits = rankResults("积分", [doc({ id: "a", title: "导数" })]);
    expect(hits).toEqual([]);
  });

  it("honors the limit and supports multi-token queries", () => {
    const docs = Array.from({ length: 30 }, (_, i) =>
      doc({ id: `d${i}`, title: `导数 ${i}`, body: "极限" }),
    );
    expect(rankResults("导数", docs)).toHaveLength(20);
    expect(rankResults("导数", docs, 5)).toHaveLength(5);
    const hits = rankResults("导数 极限", [doc({ id: "x", title: "导数", body: "极限" })]);
    expect(hits[0].score).toBe(3 + 1); // title token 导数 + body token 极限
  });

  it("breaks score ties by title ascending", () => {
    const hits = rankResults("笔记", [
      doc({ id: "2", title: "乙笔记", body: "" }),
      doc({ id: "1", title: "甲笔记", body: "" }),
    ]);
    expect(hits.map((h) => h.title)).toEqual(["甲笔记", "乙笔记"]);
  });

  it("builds a snippet centered on the first body hit", () => {
    const body = `${"前".repeat(40)}导数${"后".repeat(40)}`;
    const hits = rankResults("导数", [doc({ id: "a", title: "笔记", body })]);
    expect(hits[0].snippet).toHaveLength(60);
    expect(hits[0].snippet).toContain("导数");
    expect(hits[0].snippet.startsWith("前".repeat(10))).toBe(true);
  });

  it("falls back to the first 60 chars when only the title matches", () => {
    const hits = rankResults("导数", [doc({ id: "a", title: "导数", body: "体".repeat(100) })]);
    expect(hits[0].snippet).toBe("体".repeat(60));
  });
});
