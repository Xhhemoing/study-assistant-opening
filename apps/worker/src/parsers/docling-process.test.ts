import { describe, expect, it } from "vitest";
import { createDoclingProcess, createNodeRunner, decodeParserOutput, UnsupportedMimeError, BoundsExceededError, ConversionFailedError } from "./docling-process";

describe("docling parser bridge", () => {
  it("strictly validates pages", () => {
    expect(() => decodeParserOutput('{"pages":[{"page":0,"text":"x"}]}')).toThrow(RangeError);
    expect(decodeParserOutput('{"pages":[{"page":1,"text":"x","imagePath":null}]}')).toHaveLength(1);
    expect(() => decodeParserOutput("bad")).toThrow();
    expect(() => decodeParserOutput('{"pages":[{"page":1,"text":"x"},{"page":1,"text":"y"}]}')).toThrow();
  });

  it.each([[3, UnsupportedMimeError], [5, BoundsExceededError], [4, ConversionFailedError]])("maps exit %s", async (exitCode, ErrorType) => {
    const parser = createDoclingProcess({ run: async () => ({ exitCode, stdout: "detail" }) });
    await expect(parser.parseDocument({ path: "x", mime: "application/pdf", maxPages: 2 }, new AbortController().signal)).rejects.toBeInstanceOf(ErrorType);
  });

  it("passes argv only, without shell syntax", async () => {
    let argv: string[] = [];
    const parser = createDoclingProcess({ run: async (value) => { argv = value; return { exitCode: 0, stdout: '{"pages":[]}' }; } });
    await parser.parseDocument({ path: "a;b", mime: "application/pdf", maxPages: 2 }, new AbortController().signal);
    expect(argv).toEqual(["-m", "opening_parser", "--input", "a;b", "--mime", "application/pdf", "--max-pages", "2"]);
    expect(argv.join(" ")).not.toMatch(/[|&<>$`]/);
  });

  it("forces UTF-8 child stdout encoding for non-ASCII math text", async () => {
    const runner = createNodeRunner(process.execPath);
    const result = await runner(["-e", "console.log(process.env.PYTHONIOENCODING)"], new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("utf-8");
  });
});
