import { uploadInputSchema } from "@aistudy/contracts";
import { resolveUploadMime } from "./upload-state";

export const openingUploadAccept = ".pdf,.pptx,.html,.htm,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav,.mp4,.webm";

const typeLabels: Record<string, string> = {
  ".pdf": "PDF", ".pptx": "PPTX", ".html": "HTML", ".htm": "HTML",
  ".md": "Markdown", ".markdown": "Markdown", ".txt": "TXT", ".png": "PNG", ".jpg": "JPG", ".jpeg": "JPEG",
  ".webp": "WebP", ".mp3": "MP3", ".m4a": "M4A", ".wav": "WAV", ".mp4": "MP4", ".webm": "WebM",
};

export function supportedUploadTypesLabel(accept: string): string {
  const labels = accept.split(",").map(token => token.trim().toLowerCase()).filter(Boolean).map(token => {
    if (typeLabels[token]) return typeLabels[token];
    if (token.endsWith("/*")) return token.slice(0, -2).toUpperCase();
    return token.toUpperCase();
  });
  return [...new Set(labels)].join("、") || "所有文件";
}

export function isAcceptedUploadFile(file: Pick<File, "name" | "type">, accept: string): boolean {
  const tokens = accept.split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  if (mime) {
    return tokens.some(token => {
      if (token.endsWith("/*")) return mime.startsWith(`${token.slice(0, -1)}`);
      if (token.startsWith(".")) return resolveUploadMime({ name: `file${token}`, type: "" }) === mime;
      return mime === token;
    });
  }
  const resolved = resolveUploadMime({ name, type: "" });
  return tokens.some(token => token.startsWith(".") ? name.endsWith(token) : token.endsWith("/*") ? resolved?.startsWith(token.slice(0, -1)) : resolved === token);
}

export function uploadFileRejection(file: Pick<File, "name" | "type" | "size">, accept = openingUploadAccept): string | null {
  const mime = resolveUploadMime(file);
  if (!mime || !isAcceptedUploadFile(file, accept)) return `不支持的文件类型：${file.name}。支持类型：${supportedUploadTypesLabel(accept)}`;
  // This preflight checks file metadata before reading bytes. The upload client
  // computes the actual SHA-256 after reading the file; this value is never sent.
  const result = uploadInputSchema.safeParse({ name: file.name.slice(0, 180), mime, bytes: file.size, sha256: "0".repeat(64) });
  if (result.success) return null;
  if (result.error.issues.some(issue => issue.path[0] === "bytes")) {
    return file.size === 0 ? `文件「${file.name}」为空，请选择有内容的文件。` : `文件「${file.name}」超过此格式的大小限制，请压缩或拆分后重试。`;
  }
  return `文件名「${file.name}」无法使用，请重命名后重试。`;
}

// Bound the selection and retained retry buffers without reducing any single-file limit.
export const openingUploadBatchFiles = 20;
export const openingUploadBatchBytes = 512 * 1024 * 1024;

export function uploadBatchRejection(files: readonly Pick<File, "size">[], retained: { count: number; bytes: number } = { count: 0, bytes: 0 }): string | null {
  if (files.length + retained.count > openingUploadBatchFiles) return `待上传附件最多 ${openingUploadBatchFiles} 份，请分批上传或移除失败附件后重试。`;
  if (files.reduce((bytes, file) => bytes + file.size, retained.bytes) > openingUploadBatchBytes) return "待上传附件总大小不能超过 512 MiB，请分批上传或移除失败附件后重试。";
  return null;
}
