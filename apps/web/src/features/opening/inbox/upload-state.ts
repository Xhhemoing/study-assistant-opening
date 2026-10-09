import type { SourceRecord } from "@aistudy/contracts";

export type UploadMime =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "audio/mpeg"
  | "audio/mp4"
  | "audio/wav"
  | "text/markdown"
  | "text/html"
  | "message/rfc822"
  | "application/vnd.ms-powerpoint";

const BY_EXTENSION: Record<string, UploadMime> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  md: "text/markdown",
  markdown: "text/markdown",
  eml: "message/rfc822",
  html: "text/html",
  htm: "text/html",
  ppt: "application/vnd.ms-powerpoint",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

/** Declared MIME, else extension. Unknown files are rejected, never renamed to PDF. */
export function resolveUploadMime(input: { name: string; type: string }): UploadMime | null {
  const declared = input.type.trim().toLowerCase();
  if (Object.values(BY_EXTENSION).includes(declared as UploadMime)) return declared as UploadMime;
  if (declared) return null;
  const extension = input.name.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[extension] ?? null;
}

export function sourceStatusLabel(record: Pick<SourceRecord, "uploadState" | "parseState"> & { error?: SourceRecord["error"] }): string {
  if (record.uploadState !== "uploaded") return "等待上传完成";
  if (record.error?.code === "PRIVACY_EXCLUDED") return "已从学习上下文中排除";
  if (record.parseState === "ready") return "可以用于提问";
  if (record.parseState === "failed") return "原件已保存，解析失败";
  if (record.parseState === "unsupported") return "原件已保存，暂不能提取文字";
  if (record.parseState === "not_started" || record.parseState === "queued" || record.parseState === "running") {
    return "原件已保存，正在解析";
  }
  return "原件已保存，正在解析";
}

export function isHeicUpload(input: { name: string; type: string }): boolean {
  const declared = input.type.trim().toLowerCase();
  if (declared === "image/heic" || declared === "image/heif") return true;
  const extension = input.name.toLowerCase().split(".").pop() ?? "";
  return extension === "heic" || extension === "heif";
}

/** Rejected upload tip. HEIC/HEIF stay unsupported; ask for JPG instead of decoding. */
export function unsupportedUploadMessage(input: { name: string; type: string }): string {
  if (isHeicUpload(input)) return "请导出为 JPG 后上传";
  return "不支持这个格式，未改名也未创建材料。";
}
