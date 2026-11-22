import { LEARNER_PORTABILITY_VERSION, learnerPackageSchema, type LearnerPackage } from "@aistudy/contracts/learner-portability";

const filename = new TextEncoder().encode("learner-package.json");
const localLength = 30 + filename.length;
const centralLength = 46 + filename.length;
const footerLength = centralLength + 22;
const utf8 = 0x800;
const dosDate = 0x21; // 1980-01-01, independent of machine clock and time zone.

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipHeaders(size: number, crc: number) {
  const centralOffset = localLength + size;
  if (centralOffset + footerLength >= 0xffffffff) throw new RangeError("Learner archive exceeds Store ZIP limit");
  const localBytes = new Uint8Array(localLength);
  const local = new DataView(localBytes.buffer);
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, utf8, true);
  local.setUint16(12, dosDate, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, size, true);
  local.setUint32(22, size, true);
  local.setUint16(26, filename.length, true);
  localBytes.set(filename, 30);

  const footerBytes = new Uint8Array(footerLength);
  const central = new DataView(footerBytes.buffer, 0, centralLength);
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(8, utf8, true);
  central.setUint16(14, dosDate, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, size, true);
  central.setUint32(24, size, true);
  central.setUint16(28, filename.length, true);
  footerBytes.set(filename, 46);

  const end = new DataView(footerBytes.buffer, centralLength);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, centralLength, true);
  end.setUint32(16, centralOffset, true);
  return { localBytes, footerBytes };
}

export function createLearnerPackage(payload: Omit<LearnerPackage, "manifest">): LearnerPackage {
  return learnerPackageSchema.parse({
    ...payload,
    manifest: {
      format: "aistudy-learner-package", version: LEARNER_PORTABILITY_VERSION,
      notes: payload.notes.length, decks: payload.decks.length, reviews: payload.reviews.length,
    },
  });
}

/** Deterministic single-entry ZIP using the Store method and a CRC32 checksum. */
export function exportLearnerZip(bundle: LearnerPackage): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(learnerPackageSchema.parse(bundle)));
  const { localBytes, footerBytes } = zipHeaders(payload.length, crc32(payload));
  const archive = new Uint8Array(localBytes.length + payload.length + footerBytes.length);
  archive.set(localBytes);
  archive.set(payload, localBytes.length);
  archive.set(footerBytes, localBytes.length + payload.length);
  return archive;
}

/** Accepts the SDK's Store ZIP profile, including the central directory and CRC. */
export function importLearnerZip(archive: Uint8Array): LearnerPackage {
  if (archive.length <= localLength + footerLength) throw new TypeError("Invalid learner ZIP");
  const footerOffset = archive.length - footerLength;
  const payload = archive.subarray(localLength, footerOffset);
  const { localBytes, footerBytes } = zipHeaders(payload.length, crc32(payload));
  if (!localBytes.every((byte, index) => archive[index] === byte)
    || !footerBytes.every((byte, index) => archive[footerOffset + index] === byte)) {
    throw new TypeError("Invalid learner ZIP header or checksum");
  }
  return learnerPackageSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
}
