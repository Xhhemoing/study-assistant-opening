import { createHash } from "node:crypto";
import { loadEnv } from "@aistudy/config";
import { OpeningS3 } from "@aistudy/database";

/** Uses the caller's explicit integration service configuration, including isolated ports. */
export function createOpeningTestStorage(): OpeningS3 {
  return new OpeningS3(loadEnv().s3);
}

export const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x78)]);
export const pdfSha = createHash("sha256").update(pdfBytes).digest("hex");
export const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(204, 0x11)]);
export const jpegSha = createHash("sha256").update(jpegBytes).digest("hex");
