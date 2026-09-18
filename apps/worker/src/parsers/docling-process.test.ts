import { describe, expect, it } from "vitest";
import { createDoclingProcess, createNodeRunner, decodeParserOutput, UnsupportedMimeError, BoundsExceededError, ConversionFailedError } from "./docling-process";

describe("docling parser bridge", () => {
  it("strictly validates pages", () => {
    expect(() => decodeParserOutput('{"pages":[{"page":0,"text":"x"}]}')).toThrow(RangeError);
    expect(decodeParserOutput('{"pages":[{"page":1,"text":"x","imagePath":null}]}')).toHaveLength(1);
    expect(() => decodeParserOutput("bad")).toThrow();
    expect(() => decodeParserOutput('{"pages":[{"page":1,"text":"x"},{"page":1,"text":"y"}]}')).toThrow();
  });

  it("ignores log lines that pollute stdout before the JSON payload", () => {
    const polluted = '2026-09-18 15:05:36,284 MatchingPostProcessor WARNING  1 of 5 pdf cells matched neither a row nor a column band\n' + JSON.stringify({ pages: [{ page: 1, text: "Alpha", imagePath: null }] }) + "\r\n";
    const pages = decodeParserOutput(polluted);
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toBe("Alpha");
  });

  it.each([[3, UnsupportedMimeError], [5, BoundsExceededError], [4, ConversionFailedError]])("maps exit %s", async (exitCode, ErrorType) => {
    const parser = createDoclingProcess({ run: async () => ({ exitCode, stdout: "detail" }) });
    await expect(parser.parseDocument({ path: "x", mime: "application/pdf", maxPages: 2 }, new AbortController().signal)).rejects.toBeInstanceOf(ErrorType);
  });

  it("includes stderr tail in conversion failures", async () => {
    const parser = createDoclingProcess({ run: async () => ({ exitCode: 4, stdout: "", stderr: "conversion failed: boom" }) });
    await expect(parser.parseDocument({ path: "x", mime: "application/pdf", maxPages: 2 }, new AbortController().signal)).rejects.toThrow(/boom/);
  });

  it("passes argv only, without shell syntax, with a generous conversion timeout", async () => {
    let argv: string[] = [];
    const parser = createDoclingProcess({ run: async (value) => { argv = value; return { exitCode: 0, stdout: '{"pages":[]}' }; } });
    await parser.parseDocument({ path: "a;b", mime: "application/pdf", maxPages: 2 }, new AbortController().signal);
    expect(argv).toEqual(["-m", "opening_parser", "--input", "a;b", "--mime", "application/pdf", "--max-pages", "2", "--timeout-seconds", "900"]);
    expect(argv.join(" ")).not.toMatch(/[|&<>$`]/);
  });

  it("forces UTF-8 child stdout encoding for non-ASCII math text", async () => {
    const runner = createNodeRunner(process.execPath);
    const result = await runner(["-e", "console.log(process.env.PYTHONIOENCODING)"], new AbortController().signal);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("utf-8");
  });
});
