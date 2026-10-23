#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { pdf, scanImage, text, unsupportedDocx, zip } from "./formats.mjs";

export const DEFAULT_SEED = "opt-00-v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** In-memory fixture assembly, NOT an importer or an archive extraction API. */
export function buildSprintPack(seed = DEFAULT_SEED) {
  if (typeof seed !== "string" || !seed.length || Buffer.byteLength(seed) > 128) {
    throw new Error("seed must be a nonempty UTF-8 string of at most 128 bytes");
  }
  const makePdf = (pages, options = {}) => pdf({ pages, seed, ...options });
  const questions = makePdf([
    [text("SYNTHETIC - QUESTIONS", 740), text("1. Compute 2 + 2.", 680), text("2. Compute 3 * 3.", 630)].join("\n"),
    [text("SYNTHETIC - ANSWERS", 740), text("1. 4", 680), text("2. 9", 630)].join("\n"),
  ]);
  const conjugate = makePdf([
    [text("SYNTHETIC - COMPLEX CONJUGATE", 740),
      text("z + 3", 640, 24), "BT /F2 32 Tf 116 640 Td (A) Tj ET",
      "BT /F1 24 Tf 150 640 Td (= 4 + 2i) Tj ET",
      text("Here the bar means complex conjugation.", 570, 16),
      text("Solution: z = 1 - i", 520),
      text("Check: (1 - i) + 3(1 + i) = 4 + 2i", 480, 16),
    ].join("\n"),
  ], { conjugate: true });
  const scan = scanImage();
  const imageOnly = makePdf(["q 480 0 0 288 40 440 cm /Scan Do Q"], { image: scan });
  const gbkPdf = makePdf([text("SYNTHETIC - GBK EXERCISE", 740) + "\n" + text("1. Compute 5 - 2.", 680)]);
  const lecture = makePdf([
    text("SYNTHETIC - LECTURE", 740) + "\n" + text("Unit 01: complex numbers", 680),
    text("SYNTHETIC - LECTURE CONTINUED", 740) + "\n" + text("Conjugation reverses the imaginary part.", 680, 16),
  ]);
  const accepted = (role, pages, extra = {}) => ({
    disposition: "accept", role, pageCount: pages.length, pages, ...extra,
  });
  const ignored = (reason) => ({ disposition: "ignore", role: "metadata", pageCount: 0, pages: [], reason });
  const rejected = (reason, role = "unsupported") => ({ disposition: "reject", role, pageCount: 0, pages: [], reason });
  const nested = [
    {
      name: "资料/练习.pdf", data: gbkPdf, utf8: false,
      // Actual GBK bytes, independently decoded in tests. No Unicode-path extra field.
      rawName: Buffer.from("d7cac1cf2fc1b7cfb02e706466", "hex"),
      expected: accepted("exercises", [{ page: 1, role: "questions", questionNumbers: [1] }]),
    },
    {
      name: "lectures/overview.pdf", data: lecture,
      expected: accepted("lecture", [{ page: 1, role: "lecture" }, { page: 2, role: "lecture" }]),
    },
    { name: "__MACOSX/.DS_Store", data: Buffer.from("synthetic Finder metadata\n"), expected: ignored("macos_metadata") },
  ];
  const innerZip = zip(nested);
  const outer = [
    { name: "nested/unit-01.zip", data: innerZip, expected: { disposition: "recurse", role: "archive", archiveDepth: 2, entryCount: nested.length, pageCount: 0, pages: [] } },
    {
      name: "materials/conjugate.pdf", data: conjugate,
      expected: accepted("math_reference", [{ page: 1, role: "reference" }], {
        math: {
          unicode: "z̄", equation: "z + 3z̄ = 4 + 2i", solution: { real: 1, imaginary: -1 },
          // PDF points, origin bottom-left. Rendering tests sample bar and the gap beneath it.
          glyph: { x: 116, y: 640, fontSize: 32, barBox: [40, 740, 520, 45], unitsPerEm: 1000 },
        },
      }),
    },
    {
      name: "materials/questions-and-answers.pdf", data: questions,
      expected: accepted("questions_and_answers", [
        { page: 1, role: "questions", questionNumbers: [1, 2] },
        { page: 2, role: "answers", questionNumbers: [1, 2] },
      ], { uniqueQuestionCount: 2, numberedOccurrenceCount: 4 }),
    },
    {
      name: "materials/image-only.pdf", data: imageOnly,
      expected: accepted("scanned_exercises", [{ page: 1, role: "questions", requiresOcr: true }], {
        image: { width: scan.width, height: scan.height, bitsPerComponent: 8, colorSpace: "DeviceGray", visibleLines: ["SCAN 01", "1. 2+2=?"] },
      }),
    },
    { name: "unsupported/notes.docx", data: unsupportedDocx(), expected: rejected("unsupported_extension") },
    { name: "__MACOSX/._conjugate.pdf", data: Buffer.from("synthetic AppleDouble metadata\n"), expected: ignored("macos_metadata") },
    { name: ".DS_Store", data: Buffer.from("synthetic Finder metadata\n"), expected: ignored("macos_metadata") },
    // Intentional hostile name; never passed to a filesystem write/extract function.
    { name: "../x.pdf", data: gbkPdf, expected: { ...rejected("path_traversal", "unsafe_path"), payloadPageCount: 1 } },
  ];
  const archive = zip(outer);
  const describe = (entry) => ({
    path: entry.name, filenameEncoding: entry.utf8 === false ? "gbk" : "utf-8",
    flags: entry.utf8 === false ? 0 : 0x800,
    rawNameHex: (entry.rawName ?? Buffer.from(entry.name)).toString("hex"),
    bytes: entry.data.length, sha256: sha256(entry.data), expected: entry.expected,
  });
  const archives = [
    { path: "sprint-pack.zip", depth: 1, entryCount: outer.length, entries: outer.map(describe) },
    { path: "sprint-pack.zip!/nested/unit-01.zip", depth: 2, entryCount: nested.length, entries: nested.map(describe) },
  ];
  const allEntries = [...outer, ...nested];
  const byDisposition = (kind) => allEntries.filter((entry) => entry.expected.disposition === kind);
  const manifest = {
    fixture: "AIstudy OPT-00", schemaVersion: 1, synthetic: true, seed,
    archive: { file: "sprint-pack.zip", bytes: archive.length, sha256: sha256(archive) },
    depthConvention: "Root ZIP is depth 1; its nested ZIP is depth 2. DOCX is rejected before ZIP recursion.",
    expected: {
      maxArchiveDepth: 2, archiveCount: archives.length,
      entryCount: allEntries.length, acceptedPdfCount: byDisposition("accept").length,
      acceptedPdfPages: byDisposition("accept").reduce((sum, entry) => sum + entry.expected.pageCount, 0),
      ignoredCount: byDisposition("ignore").length, rejectedCount: byDisposition("reject").length,
    },
    archives,
  };
  return { archive, manifest };
}

/** @param {{ seed?: string, outDir?: string }} options */
export async function generateSprintPack({ seed = DEFAULT_SEED, outDir } = {}) {
  const output = path.resolve(outDir ?? fileURLToPath(new URL("./generated", import.meta.url)));
  const { archive, manifest } = buildSprintPack(seed);
  await mkdir(output, { recursive: true });
  // Only two fixed filenames, never the (potentially hostile) member names.
  await writeFile(path.join(output, "sprint-pack.zip"), archive);
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { output, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { seed: { type: "string", default: DEFAULT_SEED }, out: { type: "string" } } });
  const { output, manifest } = await generateSprintPack({ seed: values.seed, outDir: values.out });
  console.log(JSON.stringify({ output, sha256: manifest.archive.sha256, expected: manifest.expected }, null, 2));
}
