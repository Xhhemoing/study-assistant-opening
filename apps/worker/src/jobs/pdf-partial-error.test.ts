import { apiFailureSchema } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { createPdfPartialError } from "./pdf-partial-error";

describe("PDF partial error summary", () => {
  it("merges adjacent and overlapping failed ranges and sorted unique low-quality pages", () => {
    expect(createPdfPartialError(["11-20", "1-10", "20-30", "32-32"], [4, 2, 1, 2])).toEqual({
      code: "PARSE_PARTIAL",
      message: "第 1–30、32 页未能识别，可以重新解析；第 1–2、4 页识别质量低",
      retryable: true,
    });
  });

  it.each([
    { failed: [], low: Array.from({ length: 600 }, (_, i) => i + 1) },
    { failed: Array.from({ length: 1000 }, (_, i) => `${i * 2 + 1}-${i * 2 + 1}`), low: Array.from({ length: 1000 }, (_, i) => i * 2 + 2) },
  ])("keeps large summaries inside the real API failure contract", ({ failed, low }) => {
    const error = createPdfPartialError(failed, low);
    expect(apiFailureSchema.safeParse(error).success).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual(500);
    if (failed.length) {
      expect(error.message).toBe("第 1、3、5、7、9、11 等共 1000 页未能识别，可以重新解析；第 2、4、6、8、10、12 等共 1000 页识别质量低");
    } else expect(error.message).toBe("第 1–600 页识别质量低");
  });
});
