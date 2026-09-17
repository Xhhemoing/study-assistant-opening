const signatures: Record<string, (bytes: Uint8Array) => boolean> = {
  "application/pdf": (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP",
  "video/mp4": (bytes) => ascii(bytes, 4, 4) === "ftyp",
  "audio/mp4": (bytes) => ascii(bytes, 4, 4) === "ftyp",
  "audio/mpeg": (bytes) => ascii(bytes, 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0),
  "audio/wav": (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE",
  "video/webm": (bytes) => startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": (bytes) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]),
};
function startsWith(bytes: Uint8Array, signature: number[]): boolean { return signature.every((value, index) => bytes[index] === value); }
function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.slice(offset, offset + length)); }
export function magicMatchesMime(firstBytes: Uint8Array, declaredMime: string): boolean { return signatures[declaredMime]?.(firstBytes) ?? false; }
