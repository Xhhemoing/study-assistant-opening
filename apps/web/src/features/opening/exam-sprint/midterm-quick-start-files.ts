import "server-only";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { magicMatchesMime } from "@aistudy/database";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { ApiError } from "../../auth/service";

const lectureNames = [
  "Basic notions_SLIDES.pdf",
  "Topic_2_Sequences_and_Limits_SLIDES.pdf",
  "Topic_3__Differential_Calculus_SLIDES.pdf",
  "Topic_4_Integral_Calculus_SLIDES.pdf",
  "Topic_5_Series_SLIDES.pdf",
];
const exerciseNames = [...new Set(EXAM_SPRINT_PACK.sourceItems
  .filter(item => item.kind !== "exercise").map(item => item.sourceTitle))];
const mime = "application/pdf" as const;
const maxPdfBytes = 50 * 1024 * 1024;

export type MidtermPdf = { name: string; exercise: boolean; path: string; info: Stats };

const unavailable = () => new ApiError("SERVICE_UNAVAILABLE", "高数期中资料缺失、无法读取或格式不符，请检查本地上传包后重试。", 503);

export async function locateMidtermPdfs(directory: string): Promise<MidtermPdf[]> {
  try {
    const root = await realpath(directory);
    if (!(await lstat(directory)).isDirectory()) throw unavailable();
    const files = await Promise.all([...exerciseNames, ...lectureNames].map(async name => {
      const path = join(root, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size === 0 || info.size > maxPdfBytes || relative(root, await realpath(path)) !== name) throw unavailable();
      return { name, exercise: exerciseNames.includes(name), path, info };
    }));
    return files;
  } catch {
    throw unavailable();
  }
}

export async function readMidtermPdf(file: MidtermPdf) {
  try {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== file.info.dev || info.ino !== file.info.ino || info.size !== file.info.size) throw unavailable();
      // Read at most the preflight size plus one byte, including if the file grew.
      const body = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const bytes = body.subarray(0, offset);
      if (offset !== info.size || !magicMatchesMime(bytes, mime)) throw unavailable();
      return { body: bytes, metadata: { name: file.name, mime, bytes: offset, sha256: createHash("sha256").update(bytes).digest("hex") } };
    } finally {
      await handle.close();
    }
  } catch {
    throw unavailable();
  }
}
