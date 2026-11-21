import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { listShareablePitfalls } from "@aistudy/domain";
import { afterEach, expect, it, vi } from "vitest";
import OpenGraphImage from "../../../app/s/[token]/opengraph-image";
import { sharePosterFooter } from "./poster";
import { signPitfallShareToken } from "./token-codec";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("renders distinct Chinese glyphs with all outbound fetches blocked", async () => {
  vi.spyOn(process, "cwd").mockReturnValue(resolve(__dirname, "../../../.."));
  vi.stubEnv("AUTH_SECRET", "offline-share-test-secret-0123456789abcdef");
  const fetch = vi.fn(async () => { throw new Error("Offline"); });
  vi.stubGlobal("fetch", fetch);

  async function render(pitfallTitle: string) {
    const { token } = signPitfallShareToken({
      subjectLabel: "高等数学",
      pitfallTitle,
      trapSummary: "先判型",
      takeawayRule: "再求导",
      cohortSampleSize: 30,
      cohortTrapRate: 100,
    });
    const response = await OpenGraphImage({ params: Promise.resolve({ token }) });
    expect(response.status).toBe(200);
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    return png;
  }

  // Equal-length titles with identical Latin content and layout.
  const first = await render("积分");
  const second = await render("函数");
  expect(first.equals(second)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it("maps every catalog and poster character to a nonzero glyph", () => {
  const { default: parseFont } = createRequire(import.meta.url)("next/dist/compiled/@next/font/dist/fontkit");
  const font = parseFont(readFileSync(new URL("./assets/share-poster.woff", import.meta.url)));
  const route = readFileSync(new URL("../../../app/s/[token]/opengraph-image.tsx", import.meta.url), "utf8");
  const printableAscii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
  const characters = new Set([
    ...listShareablePitfalls().flatMap(entry => Object.values(entry)).join(""),
    ...route,
    ...sharePosterFooter(true),
    ...sharePosterFooter(false),
    ...printableAscii,
    ..."·–—（）×÷+-=/<>%…“”‘’，。：；！？",
  ]);
  const missing = [...characters].filter(char =>
    !/[\r\n\t]/.test(char) && !font.hasGlyphForCodePoint(char.codePointAt(0)!),
  );
  expect(missing).toEqual([]);
});
