import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseMediaSection, readCourseMediaDeepLink } from "./course-detail";
import type { CourseAsset } from "./course-model";

describe("course media deep link (CT-04)", () => {
  it("parses mediaSource and seekMs", () => {
    expect(readCourseMediaDeepLink("?mediaSource=src-1&seekMs=4500")).toEqual({
      sourceId: "src-1",
      seekMs: 4500,
    });
    expect(readCourseMediaDeepLink("")).toEqual({ sourceId: null, seekMs: null });
    expect(readCourseMediaDeepLink("?mediaSource=src-1&seekMs=nope").seekMs).toBeNull();
  });
});

describe("CourseMediaSection (CT-01 / CT-08)", () => {
  it("lists sources without mounting a MediaReader until selected", () => {
    const assets: CourseAsset[] = [
      { id: "a1", assetType: "source", assetId: "s1", role: "primary", sortOrder: 0, source: { id: "s1", name: "讲解视频" } },
      { id: "a2", assetType: "source", assetId: "s2", role: "extra", sortOrder: 1, source: { id: "s2", name: "音频笔记" } },
    ];
    const html = renderToStaticMarkup(createElement(CourseMediaSection, { assets }));
    expect(html).toContain('id="course-media"');
    expect(html).toContain("讲解视频");
    expect(html).toContain("音频笔记");
    expect(html).toContain("尚未选择材料");
    expect(html).not.toContain("正在读取媒体片段");
    expect(html).toContain("仅打开材料库，暂不能定位");
  });

  it("renders nothing when there are no source assets", () => {
    const html = renderToStaticMarkup(createElement(CourseMediaSection, {
      assets: [{ id: "a1", assetType: "document", assetId: "d1", role: "primary", sortOrder: 0, document: { id: "d1", title: "讲义", updatedAt: "2026-01-01" } }],
    }));
    expect(html).toBe("");
  });
});
