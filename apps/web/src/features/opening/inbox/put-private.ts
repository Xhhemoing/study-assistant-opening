import { guardSessionRequest } from "../../auth/session-expiry";
import { UploadUserError } from "./upload-error";
import type { SessionIdentity } from "../../auth/session-identity";
import { uploadIdentityHeaders } from "./upload-identity";

export type PutProgress = (loaded: number, total: number) => void;

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
        if (xhr.status === 401) {
          let body: unknown = null;
          try { body = JSON.parse(xhr.responseText); } catch { /* Non-JSON gateway errors retain upload error handling. */ }
          guard.inspectFailure(xhr.status, body);
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
