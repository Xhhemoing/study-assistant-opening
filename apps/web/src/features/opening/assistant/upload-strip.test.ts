import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { UploadQueueItem } from "../inbox/upload-queue";
import { uploadStripItemStatus } from "./upload-strip";
const source = { id: "material", uploadState: "uploaded", parseState: "queued" } as SourceRecord;
const item: UploadQueueItem = { id: "upload", file: { name: "lecture.pdf", type: "application/pdf", bytes: new Uint8Array([1]) }, state: "saved", source, progress: 100 };
describe("assistant upload queue processing status", () => {
  it("uses the refreshed source's real ready or failure state rather than the saved upload snapshot", () => {
    expect(uploadStripItemStatus(item, [{ ...source, parseState: "ready" }])).toBe("可以用于提问");
    expect(uploadStripItemStatus(item, [{ ...source, parseState: "failed", error: { code: "PARSE_FAILED", message: "解析失败，请重试", retryable: true } }])).toBe("解析失败，请重试");
    expect(uploadStripItemStatus(item, [{ ...source, parseState: "unsupported" }])).toContain("暂不能提取文字");
  });
  it("separates upload bytes from processing and does not invent current state for an absent source", () => {
    expect(uploadStripItemStatus({ ...item, state: "uploading", progress: 55 }, [])).toBe("上传中 55%");
    expect(uploadStripItemStatus({ ...item, state: "failed", message: "上传网络中断" }, [])).toBe("上传网络中断");
    expect(uploadStripItemStatus(item, [])).toContain("状态待核实");
    expect(uploadStripItemStatus(item, [source])).toContain("解析排队中");
  });
});
