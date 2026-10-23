// Independent readers for the OPT-00 behavioral tests and offline verification.
// Never extracts ZIP members to disk. Not a production importer/security policy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const JSZip = webRequire("jszip");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let pdfRuntime;
async function pdfjs() {
  if (!pdfRuntime) {
    // Explicit local validation override for an incomplete node_modules tree.
    // Normal CI resolves the already declared/locked Web dependency.
    const modulePath = process.env.SPRINT_FIXTURE_PDFJS_ROOT
      ? path.join(process.env.SPRINT_FIXTURE_PDFJS_ROOT, "legacy/build/pdf.mjs")
      : webRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    pdfRuntime = import(pathToFileURL(modulePath).href);
  }
  return pdfRuntime;
}

/** Inspect actual central AND local header bytes; JSZip also validates CRC below. */
export function zipHeaders(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 20), 0); // fixed, empty archive comment
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  let offset = bytes.readUInt32LE(end + 16);
  const centralStart = offset;
  const result = [];
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), flags);
    assert.equal(bytes.readUInt16LE(local + 8), method);
    assert.equal(bytes.readUInt16LE(local + 26), nameLength);
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + nameLength), name);
    assert.equal(bytes.readUInt16LE(local + 28), 0);
    assert.equal(extraLength, 0); // no Unicode path extra field hiding UTF-8 names
    assert.equal(commentLength, 0);
    assert.equal(method, 0); // STORE
    assert.equal(flags & 1, 0); // not encrypted
    assert.equal(bytes.readUInt32LE(local + 14), bytes.readUInt32LE(offset + 16));
    assert.equal(bytes.readUInt32LE(local + 18), compressedSize);
    assert.equal(bytes.readUInt32LE(local + 22), bytes.readUInt32LE(offset + 24));
    assert.equal(compressedSize, bytes.readUInt32LE(local + 22));
    assert.equal(bytes.readUInt16LE(local + 10), 0);
    assert.equal(bytes.readUInt16LE(local + 12), 0x21);
    assert.equal(bytes.readUInt16LE(offset + 12), 0);
    assert.equal(bytes.readUInt16LE(offset + 14), 0x21);
    const dataStart = local + 30 + nameLength;
    assert.ok(dataStart + compressedSize <= centralStart);
    result.push({ name, flags, data: bytes.subarray(dataStart, dataStart + compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  assert.equal(offset - centralStart, bytes.readUInt32LE(end + 12));
  return result;
}

export async function readArchive(bytes) {
  const raw = zipHeaders(bytes);
  const archive = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    decodeFileName: (name) => new TextDecoder("gbk", { fatal: true }).decode(name),
  });
  const entries = await Promise.all(Object.values(archive.files).map(async (entry) => ({
    // JSZip sanitizes ../x.pdf to x.pdf; preserve its original unsafe name for checks.
    name: entry.unsafeOriginalName ?? entry.name,
    sanitizedName: entry.name,
    data: await entry.async("nodebuffer"),
  })));
  assert.equal(entries.length, raw.length);
  raw.forEach((header, index) => {
    const name = new TextDecoder(header.flags & 0x800 ? "utf-8" : "gbk", { fatal: true }).decode(header.name);
    assert.equal(entries[index].name, name);
    assert.deepEqual(entries[index].data, header.data);
    Object.assign(entries[index], { rawName: header.name, flags: header.flags });
  });
  return entries;
}

export async function loadPack(output) {
  const archive = await readFile(path.join(output, "sprint-pack.zip"));
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.equal(digest(archive), manifest.archive.sha256);
  assert.equal(archive.length, manifest.archive.bytes);
  const outer = await readArchive(archive);
  const inner = await readArchive(member(outer, "nested/unit-01.zip").data);
  return { archive, manifest, outer, inner };
}

export function member(entries, name) {
  const entry = entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `missing ZIP member: ${name}`);
  return entry;
}

export function verifyManifest(pack) {
  const { manifest, outer, inner } = pack;
  assert.equal(manifest.synthetic, true);
  assert.deepEqual(manifest.expected, {
    maxArchiveDepth: 2, archiveCount: 2, entryCount: 11,
    acceptedPdfCount: 5, acceptedPdfPages: 7, ignoredCount: 3, rejectedCount: 2,
  });
  assert.deepEqual(manifest.archives.map(({ depth, entryCount }) => ({ depth, entryCount })), [
    { depth: 1, entryCount: 8 }, { depth: 2, entryCount: 3 },
  ]);
  assert.deepEqual(outer.filter((entry) => entry.name.endsWith(".zip")).map((entry) => entry.name), ["nested/unit-01.zip"]);
  assert.equal(inner.filter((entry) => entry.name.endsWith(".zip")).length, 0);
  assert.deepEqual(manifest.archives.flatMap((archive) => archive.entries)
    .filter((entry) => entry.expected.disposition === "accept")
    .map((entry) => [entry.path, entry.expected.role, entry.expected.pages.map((page) => page.role)]), [
    ["materials/conjugate.pdf", "math_reference", ["reference"]],
    ["materials/questions-and-answers.pdf", "questions_and_answers", ["questions", "answers"]],
    ["materials/image-only.pdf", "scanned_exercises", ["questions"]],
    ["资料/练习.pdf", "exercises", ["questions"]],
    ["lectures/overview.pdf", "lecture", ["lecture", "lecture"]],
  ]);
  [outer, inner].forEach((entries, index) => {
    const expected = manifest.archives[index];
    assert.equal(entries.length, expected.entryCount);
    assert.deepEqual(entries.map((entry) => entry.name), expected.entries.map((entry) => entry.path));
    for (const entry of entries) {
      const record = expected.entries.find((candidate) => candidate.path === entry.name);
      assert.equal(record.bytes, entry.data.length);
      assert.equal(record.sha256, digest(entry.data));
      assert.equal(record.flags, entry.flags);
      assert.equal(record.rawNameHex, entry.rawName.toString("hex"));
      assert.equal(record.filenameEncoding, entry.flags & 0x800 ? "utf-8" : "gbk");
    }
  });
}

export function verifyGbk(pack) {
  const entry = member(pack.inner, "资料/练习.pdf");
  assert.equal(entry.flags & 0x800, 0);
  assert.equal(entry.rawName.toString("hex"), "d7cac1cf2fc1b7cfb02e706466");
  assert.equal(new TextDecoder("gbk", { fatal: true }).decode(entry.rawName), "资料/练习.pdf");
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(entry.rawName));
}

export async function withPdf(bytes, callback) {
  const runtime = await pdfjs();
  const task = runtime.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true,
    // No external URLs, remote fonts, model calls, or browser involved.
    isEvalSupported: false, useWorkerFetch: false,
  });
  try {
    return await callback(await task.promise, runtime);
  } finally {
    await task.destroy();
  }
}

export async function verifyPdfPages(pack) {
  let pages = 0;
  let count = 0;
  for (const [index, entries] of [pack.outer, pack.inner].entries()) {
    for (const record of pack.manifest.archives[index].entries) {
      if (record.expected.disposition !== "accept") continue;
      const entry = member(entries, record.path);
      await withPdf(entry.data, async (document) => {
        assert.equal(document.numPages, record.expected.pageCount, record.path);
        assert.deepEqual(record.expected.pages.map((page) => page.page), Array.from({ length: document.numPages }, (_, i) => i + 1));
        for (let page = 1; page <= document.numPages; page++) {
          const parsed = await document.getPage(page);
          assert.deepEqual(parsed.view, [0, 0, 612, 792]);
          assert.ok((await parsed.getOperatorList()).fnArray.length > 0);
        }
        pages += document.numPages;
        count++;
      });
    }
  }
  assert.equal(count, 5);
  assert.equal(pages, 7);
  return { count, pages };
}

const pageText = async (page) => (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str).join("\n");

export async function verifyRepeatedQuestions(pack) {
  await withPdf(member(pack.outer, "materials/questions-and-answers.pdf").data, async (document) => {
    const questions = await pageText(await document.getPage(1));
    const answers = await pageText(await document.getPage(2));
    assert.match(questions, /SYNTHETIC - QUESTIONS/);
    assert.match(answers, /SYNTHETIC - ANSWERS/);
    const numbers = (value) => [...value.matchAll(/^(\d+)\./gm)].map((match) => Number(match[1]));
    assert.deepEqual(numbers(questions), [1, 2]);
    assert.deepEqual(numbers(answers), [1, 2]);
    assert.match(questions, /1\. Compute 2 \+ 2\./);
    assert.match(answers, /1\. 4/);
    assert.match(answers, /2\. 9/);
    const record = pack.manifest.archives[0].entries.find((entry) => entry.path === "materials/questions-and-answers.pdf");
    assert.equal(record.expected.uniqueQuestionCount, numbers(questions).length);
    assert.equal(record.expected.numberedOccurrenceCount, numbers(questions + "\n" + answers).length);
    assert.deepEqual(record.expected.pages.map(({ role, questionNumbers }) => ({ role, questionNumbers })), [
      { role: "questions", questionNumbers: [1, 2] }, { role: "answers", questionNumbers: [1, 2] },
    ]);
  });
}

async function render(page, document) {
  const viewport = page.getViewport({ scale: 1 });
  const surface = document.canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: surface.context, canvas: surface.canvas, viewport }).promise;
  return surface;
}

function darkPixels(context, x, y, width, height) {
  const data = context.getImageData(x, y, width, height).data;
  let dark = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] < 128 && data[index + 1] < 128 && data[index + 2] < 128 && data[index + 3] > 128) dark++;
  }
  return dark;
}

export async function verifyConjugate(pack) {
  await withPdf(member(pack.outer, "materials/conjugate.pdf").data, async (document) => {
    const page = await document.getPage(1);
    const extracted = (await pageText(page)).replace(/\s+/g, "");
    assert.ok(extracted.includes("z+3z̄=4+2i"), extracted);
    assert.ok(extracted.includes("Solution:z=1-i"));
    const record = pack.manifest.archives[0].entries.find((entry) => entry.path === "materials/conjugate.pdf");
    assert.equal(record.expected.math.unicode, "z̄");
    assert.equal(record.expected.math.equation, "z + 3z̄ = 4 + 2i");
    const { real, imaginary } = record.expected.math.solution;
    assert.deepEqual([real + 3 * real, imaginary - 3 * imaginary], [4, 2]);
    // Independently known crop in PDF points: distinguish a painted overbar from
    // ToUnicode/ActualText-only claims. Image origin is top-left after rendering.
    const surface = await render(page, document);
    try {
      assert.ok(darkPixels(surface.context, 117, 126, 18, 4) >= 14, "missing visible conjugation bar");
      assert.equal(darkPixels(surface.context, 118, 130, 14, 2), 0, "bar must sit above z with a gap");
      assert.ok(darkPixels(surface.context, 117, 134, 18, 18) > 20, "missing visible z glyph");
    } finally {
      document.canvasFactory.destroy(surface);
    }
  });
}

export async function verifyImageOnly(pack) {
  await withPdf(member(pack.outer, "materials/image-only.pdf").data, async (document, runtime) => {
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    assert.equal((await pageText(page)).trim(), "");
    const operators = await page.getOperatorList();
    assert.ok(operators.fnArray.includes(runtime.OPS.paintImageXObject));
    assert.ok(!operators.fnArray.includes(runtime.OPS.beginText));
    assert.ok(!operators.fnArray.includes(runtime.OPS.showText));
    const index = operators.fnArray.indexOf(runtime.OPS.paintImageXObject);
    const [imageId, width, height] = operators.argsArray[index];
    assert.deepEqual([width, height], [160, 96]);
    const image = await new Promise((resolve) => page.objs.get(imageId, resolve));
    assert.equal(image.width, 160);
    assert.equal(image.height, 96);
    assert.equal(image.data.length, 160 * 96 * 3); // PDF.js decoded gray samples to RGB
    const surface = await render(page, document);
    try {
      assert.equal(darkPixels(surface.context, 40, 64, 20, 20), 0);
      assert.ok(darkPixels(surface.context, 70, 100, 260, 45) > 100, "scan heading must have painted pixels");
      assert.ok(darkPixels(surface.context, 70, 196, 300, 45) > 100, "scan exercise must have painted pixels");
    } finally {
      document.canvasFactory.destroy(surface);
    }
  });
}

export async function verifySpecialEntries(pack) {
  const records = pack.manifest.archives.flatMap((archive) => archive.entries);
  assert.deepEqual(records.filter((entry) => entry.expected.disposition === "ignore").map((entry) => [entry.path, entry.expected.reason]), [
    ["__MACOSX/._conjugate.pdf", "macos_metadata"], [".DS_Store", "macos_metadata"], ["__MACOSX/.DS_Store", "macos_metadata"],
  ]);
  assert.deepEqual(records.filter((entry) => entry.expected.disposition === "reject").map((entry) => [entry.path, entry.expected.reason]), [
    ["unsupported/notes.docx", "unsupported_extension"], ["../x.pdf", "path_traversal"],
  ]);
  const unsafe = member(pack.outer, "../x.pdf");
  assert.equal(unsafe.rawName.toString("utf8"), "../x.pdf");
  assert.equal(unsafe.sanitizedName, "x.pdf");
  await withPdf(unsafe.data, async (document) => assert.equal(document.numPages, 1));
  const docx = await readArchive(member(pack.outer, "unsupported/notes.docx").data);
  assert.deepEqual(docx.map((entry) => entry.name), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assert.match(member(docx, "[Content_Types].xml").data.toString("utf8"), /wordprocessingml\.document\.main\+xml/);
  assert.match(member(docx, "_rels/.rels").data.toString("utf8"), /Target="word\/document.xml"/);
  assert.match(member(docx, "word/document.xml").data.toString("utf8"), /<w:t>Synthetic unsupported DOCX fixture\.<\/w:t>/);
}

export async function verifySprintPack(output) {
  const pack = await loadPack(output);
  verifyManifest(pack);
  verifyGbk(pack);
  const pdfs = await verifyPdfPages(pack);
  await verifyRepeatedQuestions(pack);
  await verifyConjugate(pack);
  await verifyImageOnly(pack);
  await verifySpecialEntries(pack);
  return { sha256: digest(pack.archive), entries: pack.outer.length + pack.inner.length, pdfs, checks: ["ZIP CRC/header/depth", "GBK bytes", "PDF pages", "repeated questions", "conjugate Unicode + rendered bar", "image-only decoded + rendered", "metadata/traversal/DOCX"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv[2] ?? fileURLToPath(new URL("./generated", import.meta.url));
  console.log(JSON.stringify(await verifySprintPack(output), null, 2));
}
