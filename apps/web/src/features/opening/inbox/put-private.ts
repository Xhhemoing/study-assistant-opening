import { guardSessionRequest } from "../../auth/session-expiry";
import { UploadUserError } from "./upload-error";
import type { SessionIdentity } from "../../auth/session-identity";
import { uploadIdentityHeaders } from "./upload-identity";

export type PutProgress = (loaded: number, total: number) => void;

function parseJsonSafely(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function isUploadMismatchBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if ("code" in body && body.code === "UPLOAD_MISMATCH") return true;
  if (!("error" in body) || !body.error || typeof body.error !== "object") return false;
  return "code" in body.error && body.error.code === "UPLOAD_MISMATCH";
}

/** Private object PUT. Progress counts uploaded bytes, never server parse percent. */
export function putPrivateBytes(
  url: string,
  body: Uint8Array,
  mime: string,
  onProgress?: PutProgress,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
  expectedIdentity?: SessionIdentity | null,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const guard = guardSessionRequest(url);
    if (guard.blocked) { reject(new UploadUserError("请先登录原账户并验证，再继续上传。")); return; }
    const xhr = xhrFactory();
    if (signal?.aborted) { reject(new UploadUserError("上传已取消")); return; }
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    xhr.open("PUT", url);
    // Same-origin relative URLs send cookies by default; keep credentials if begin ever returns absolute same-site URL.
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", mime);
    for (const [name, value] of Object.entries(uploadIdentityHeaders(expectedIdentity))) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const body = xhr.status === 400 || xhr.status === 401 ? parseJsonSafely(xhr.responseText) : null;
        if (xhr.status === 401) guard.inspectFailure(xhr.status, body);
        if (xhr.status === 400 && isUploadMismatchBody(body)) {
          reject(new UploadUserError("文件内容与扩展名不匹配，请确认未损坏或改名后重试。", "UPLOAD_MISMATCH"));
          return;
        }
        reject(new UploadUserError(`上传对象失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new UploadUserError("上传中断（网络错误）")); };
    xhr.onabort = () => { cleanup(); reject(new UploadUserError("上传已取消")); };
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}
