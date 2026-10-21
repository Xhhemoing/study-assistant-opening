import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import { citationReaderTarget, loadCitationReaderRecord } from "./citation-reader-host";
import { sourceViewerHref } from "./source-viewer";

const sourceId = "11111111-1111-4111-8111-111111111111";
const click = { href: sourceViewerHref(sourceId, 0, { page: 3, slideLabel: "A-1", startMs: 65000 }), origin: "https://study.example", button: 0 };
const record = { id: sourceId, version: 1, uploadState: "uploaded" } as SourceRecord;

describe("in-place citation reading", () => {
  it("preserves the exact source/version and all supported citation locators", () => {
    expect(citationReaderTarget(click)).toEqual({ sourceId, version: 0, page: 3, slideLabel: "A-1", startMs: 65000 });
  });
  it.each([
    { button: 1 }, { modified: true }, { defaultPrevented: true }, { download: true }, { target: "_blank" },
    { inLibrary: true }, { withinReader: true }, { href: `https://external.example${click.href}` },
    { href: `/opening/library/${sourceId}` }, { href: "/opening/library?tab=materials&source=bad&version=2" },
    { href: `/opening/library?source=${sourceId}&version=2` },
  ])("preserves native navigation when interception is inappropriate: %j", change => {
    expect(citationReaderTarget({ ...click, ...change })).toBeNull();
  });
  it("reports inaccessible or incomplete materials without substituting another source", async () => {
    const api = { listSources: vi.fn(async () => [record]) };
    const target = { sourceId, version: 0, page: 3 };
    expect(await loadCitationReaderRecord(api, target)).toBe(record);
    await expect(loadCitationReaderRecord(api, { ...target, sourceId: "missing" })).rejects.toThrow("已移除");
    await expect(loadCitationReaderRecord(api, { ...target, version: 2 })).rejects.toThrow("引用时的材料内容暂时无法读取");
    api.listSources.mockResolvedValueOnce([{ ...record, uploadState: "pending" }]);
    await expect(loadCitationReaderRecord(api, target)).rejects.toThrow("尚未上传完成");
    api.listSources.mockRejectedValueOnce(new Error("network failed"));
    await expect(loadCitationReaderRecord(api, target)).rejects.toThrow("network failed");
  });
});
