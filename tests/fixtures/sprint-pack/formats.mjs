// Tiny writers for synthetic fixtures only. No archive extraction or input parser.
// STORE + fixed headers avoid compressor/platform/clock-dependent output.
export function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data, rawName = Buffer.from(name, "utf8"), utf8 = true } of entries) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8 ? 0x800 : 0, 6);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, time 00:00:00
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(rawName.length, 26);
    localParts.push(local, rawName, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x314, 4); // Unix, ZIP 2.0
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE((0o100644 * 65536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, rawName);
    offset += local.length + rawName.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function stream(dictionary, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "ascii");
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`, "ascii"),
    bytes,
    Buffer.from("\nendstream", "ascii"),
  ]);
}

const literal = (value) => value.replace(/[\\()]/g, "\\$&");
export const text = (value, y, size = 18) =>
  `BT /F1 ${size} Tf 40 ${y} Td (${literal(value)}) Tj ET`;

// Type3 glyph A is a drawn z with a separate, visible bar. ToUnicode maps the
// *same painted glyph* to U+007A U+0304; it is not invisible replacement text.
const conjugateGlyph = "600 0 d0\n45 w 60 560 m 520 560 l 60 60 l 520 60 l S\n40 740 520 45 re f";
const conjugateMap = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /SyntheticConjugate def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
1 beginbfchar <41> <007A0304> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;

export function pdf({ pages, seed, conjugate = false, image = null }) {
  const objects = [null, null]; // Catalog and page tree, filled after page allocation.
  const add = (body) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "ascii"));
  // Image-only PDFs deliberately have no font resources or text-show operators.
  const font = image ? null : add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let mathFont;
  if (conjugate) {
    const glyph = add(stream("", conjugateGlyph));
    const unicode = add(stream("", conjugateMap));
    mathFont = add(`<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 800]
/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /zbar ${glyph} 0 R >>
/Encoding << /Type /Encoding /Differences [65 /zbar] >>
/FirstChar 65 /LastChar 65 /Widths [600] /Resources << >> /ToUnicode ${unicode} 0 R >>`);
  }
  const imageId = image ? add(stream(`/Type /XObject /Subtype /Image /Width ${image.width}
/Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, image.pixels)) : null;
  const pageIds = [];
  for (const commands of pages) {
    const content = add(stream("", commands));
    const resources = imageId
      ? `/XObject << /Scan ${imageId} 0 R >>`
      : `/Font << /F1 ${font} 0 R ${mathFont ? `/F2 ${mathFont} 0 R` : ""} >>`;
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]
/Resources << ${resources} >> /Contents ${content} 0 R >>`));
  }
  const info = add(`<< /Producer (AIstudy OPT-00 synthetic v1) /Subject (seed-utf8-hex:${Buffer.from(seed).toString("hex")}) >>`);
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let offset = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(object);
    offset += object.length;
  });
  const xref = offsets.map((position, index) => `${String(position).padStart(10, "0")} ${index ? "00000 n" : "65535 f"} \n`).join("");
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

// Original 5x7 bitmap lettering: readable synthetic scan, no system font assets.
export function scanImage() {
  const glyphs = {
    S: ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
    C: ["11111", "10000", "10000", "10000", "10000", "10000", "11111"],
    A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    "=": ["00000", "11111", "00000", "00000", "11111", "00000", "00000"],
    "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00100", "00100"],
  };
  const width = 160;
  const height = 96;
  const pixels = Buffer.alloc(width * height, 255);
  ["SCAN 01", "1. 2+2=?"].forEach((line, lineIndex) => {
    [...line].forEach((character, column) => {
      for (const [row, pattern] of (glyphs[character] ?? []).entries()) {
        for (const [x, value] of [...pattern].entries()) {
          if (value !== "1") continue;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            pixels[(12 + lineIndex * 32 + row * 2 + dy) * width + 10 + column * 12 + x * 2 + dx] = 0;
          }
        }
      }
    });
  });
  return { width, height, pixels };
}

export function unsupportedDocx() {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: "_rels/.rels", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: "word/document.xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic unsupported DOCX fixture.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>') },
  ]);
}
