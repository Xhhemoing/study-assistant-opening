export type PutProgress = (loaded: number, total: number) => void;

/** Private object PUT. Progress counts uploaded bytes, never server parse percent. */
export function putPrivateBytes(
  url: string,
  body: Uint8Array,
  mime: string,
  onProgress?: PutProgress,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    xhr.open("PUT", url);
    // Same-origin relative URLs send cookies by default; keep credentials if begin ever returns absolute same-site URL.
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", mime);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`上传对象失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("上传中断（网络错误）"));
    xhr.onabort = () => reject(new Error("上传已取消"));
    xhr.send(body);
  });
}
