import { describe, expect, it, vi } from "vitest";
import { putPrivateBytes } from "./put-private";

class FakeXhr {
  status = 200;
  upload = { onprogress: (_event: ProgressEvent) => undefined };
  private load: (() => void) | null = null;
  open = vi.fn();
  setRequestHeader = vi.fn();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  send(body: Uint8Array) {
    this.upload.onprogress({ lengthComputable: true, loaded: 4, total: body.byteLength } as ProgressEvent);
    this.upload.onprogress({ lengthComputable: true, loaded: body.byteLength, total: body.byteLength } as ProgressEvent);
    this.onload?.();
  }
}

describe("putPrivateBytes", () => {
  it("reports actual uploaded bytes for a private PUT", async () => {
    const seen: number[] = [];
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await putPrivateBytes(
      "https://minio.local/private",
      body,
      "application/pdf",
      (loaded, total) => seen.push(loaded / total),
      () => new FakeXhr() as unknown as XMLHttpRequest,
    );
    expect(seen).toEqual([0.5, 1]);
  });
});
