import { describe, expect, it } from "vitest";
import { checkPdfPageQuality } from "./pdf-page-quality";

describe("PDF page quality", () => {
  it("accepts readable Chinese and mathematical text", () => {
    expect(checkPdfPageQuality("这是正常的数学文本：f(x)=x²+1。\n定义域为实数。\n").quality).toBe("ok");
  });
  it("flags replacement-character corruption", () => {
    expect(checkPdfPageQuality("�������乱码文本").quality).toBe("low_quality");
  });
  it("flags nearly blank pages", () => {
    expect(checkPdfPageQuality("   \n\t  ").quality).toBe("low_quality");
  });
});