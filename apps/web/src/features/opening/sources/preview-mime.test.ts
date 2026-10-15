import { describe, expect, it } from "vitest";
import { isPreviewableMime, sourcePreviewKind } from "./preview-mime";

describe("preview mime helpers", () => {
  it("classifies previewable MIME kinds", () => {
    expect(isPreviewableMime("application/pdf")).toBe(true);
    expect(isPreviewableMime("image/jpeg")).toBe(true);
    expect(isPreviewableMime("text/plain; charset=utf-8")).toBe(true);
    expect(isPreviewableMime("text/markdown")).toBe(true);
    expect(isPreviewableMime("application/vnd.ms-powerpoint")).toBe(false);
    expect(sourcePreviewKind("application/pdf")).toBe("pdf");
    expect(sourcePreviewKind("image/png")).toBe("image");
    expect(sourcePreviewKind("text/markdown")).toBe("text");
    expect(sourcePreviewKind("audio/mpeg")).toBeNull();
  });
});
