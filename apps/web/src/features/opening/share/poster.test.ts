import { describe, expect, it } from "vitest";
import { buildPitfallPosterSvg, buildPosterFilename, escapeXml, stripXmlIllegalChars } from "./poster";
import { hasDisallowedXmlOrControlChars } from "./schema";

describe("deterministic XML-escaped SVG poster builder", () => {
  const baseCard = {
    subjectLabel: "数据结构",
    pitfallTitle: "二分查找边界写成 < 还是 <= 常常死循环",
    trapSummary: "区间定义 [left, right] 与 [left, right) 混用，导致更新 right = mid 时卡死。",
    takeawayRule: "先定不变量：闭区间用 <= 且减一加一，左闭右开用 < 且 right = mid。",
    cohortSampleSize: 64,
    cohortTrapRate: 58,
  };

  it("generates deterministic SVG output with valid XML structure", () => {
    const svgA = buildPitfallPosterSvg(baseCard);
    const svgB = buildPitfallPosterSvg(baseCard);
    expect(svgA).toBe(svgB);
    expect(svgA.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svgA).toContain('viewBox="0 0 900 1200"');
    expect(svgA).toContain("约 58% 同学曾在此踩坑 · 64 人样本");
    expect(svgA).toContain("90 秒亲自排雷挑战");
  });

  it("escapes <script> and XML/attribute injection payloads completely", () => {
    const hostileCard = {
      subjectLabel: `<script>alert("s")</script>`,
      pitfallTitle: `"><script>alert(1)</script><svg onload="alert(2)">`,
      trapSummary: `注意 a < b && c > d 且不要写 ' onclick="evil()"`,
      takeawayRule: `</text><script>fetch("https://evil.example")</script><text>`,
      cohortSampleSize: 40,
      cohortTrapRate: 45,
    };

    const svg = buildPitfallPosterSvg(hostileCard);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("</script>");
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain('onload="');
    expect(svg).not.toContain('onclick="');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;&amp;");
    expect(svg).toContain("&#39;");
    expect(escapeXml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("strips XML 1.0 illegal code points (U+FFFE, U+FFFF, lone surrogates) while preserving valid surrogate pairs", () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdfff);
    const validPair = "𠮷"; // U+20BB7

    const dirtyCard = {
      subjectLabel: `高数\uFFFE\u0080测\u009F\uFFFF试`,
      pitfallTitle: `包含${loneHigh}孤立高代理与${loneLow}孤立低代理以及合法字形${validPair}\uFFFF`,
      trapSummary: `带空字符\u0000与\uFFFE和\uFFFF的易错摘要${loneHigh}`,
      takeawayRule: `口诀\uFFFF保留合法字符${validPair}${loneLow}并保持合法XML`,
      cohortSampleSize: 35,
      cohortTrapRate: 60,
    };

    const svg = buildPitfallPosterSvg(dirtyCard);
    expect(hasDisallowedXmlOrControlChars(svg)).toBe(false);
    expect(svg).not.toContain("\uFFFE");
    expect(svg).not.toContain("\uFFFF");
    expect(svg).not.toContain("\u0000");
    expect(svg).toContain(validPair);
    expect(svg).toContain("高数测试");
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);

    // Direct helper assertions
    expect(stripXmlIllegalChars(`A\uFFFEB\uFFFFC${loneHigh}D${loneLow}E${validPair}`)).toBe(
      `ABCDE${validPair}`,
    );
  });

  it("omits cohort trap rate badge whenever cohortSampleSize < 30", () => {
    const svg = buildPitfallPosterSvg({
      ...baseCard,
      cohortSampleSize: 18,
      cohortTrapRate: 82,
    });
    expect(svg).not.toContain("82%");
    expect(svg).not.toContain("人样本");
  });

  it("builds a filesystem-safe SVG filename", () => {
    expect(
      buildPosterFilename({
        subjectLabel: "高等数学 / 微积分",
        pitfallTitle: `a<b>:c*?"|d`,
      }),
    ).toMatch(/^aistudy-[^\\/:*?"<>|]+\.svg$/);
  });
});
