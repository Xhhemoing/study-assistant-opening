import { describe, expect, it } from "vitest";
import { magicMatchesMime } from "./magic";

const cases: [string, number[]][] = [
  ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/webp", [...Buffer.from("RIFFxxxxWEBP")]],
  ["video/mp4", [...Buffer.from("xxxxftyp")]],
  ["audio/mp4", [...Buffer.from("xxxxftyp")]],
  ["audio/mpeg", [...Buffer.from("ID3")]],
  ["audio/wav", [...Buffer.from("RIFFxxxxWAVE")]],
  ["video/webm", [0x1a, 0x45, 0xdf, 0xa3]],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", [0x50, 0x4b, 0x03, 0x04]],
];

describe("magicMatchesMime", () => {
  it.each(cases)("accepts %s", (mime, bytes) => {
    expect(magicMatchesMime(Uint8Array.from(bytes), mime)).toBe(true);
  });
  it("rejects spoofed and empty content", () => {
    expect(magicMatchesMime(Uint8Array.from([0xff, 0xd8, 0xff]), "application/pdf")).toBe(false);
    expect(magicMatchesMime(new Uint8Array(), "image/png")).toBe(false);
  });
});
