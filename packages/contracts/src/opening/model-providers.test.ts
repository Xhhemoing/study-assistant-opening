import { describe, expect, it } from "vitest";
import { isOpeningProviderBaseUrl, normalizeOpeningProviderBaseUrl, openingProviderInputSchema } from "./model-providers";

describe("provider endpoint contract", () => {
  it("normalizes equivalent URLs for credential destination comparisons", () => {
    expect(normalizeOpeningProviderBaseUrl(" HTTPS://API.EXAMPLE.COM:443/v1/ ")).toBe("https://api.example.com/v1");
    expect(openingProviderInputSchema.parse({ label: "Model", baseUrl: "https://api.example.com/v1/" }).baseUrl).toBe("https://api.example.com/v1");
  });
  it("validates local URL syntax without reading server environment policy", () => {
    expect(openingProviderInputSchema.parse({ label: "Model", baseUrl: "http://localhost:8000/v1" }).baseUrl).toBe("http://localhost:8000/v1");
    expect(isOpeningProviderBaseUrl("http://localhost:8000/v1", { allowLocal: false })).toBe(false);
    expect(isOpeningProviderBaseUrl("http://localhost:8000/v1", { allowLocal: true })).toBe(true);
  });
  it.each(["http://remote.example", "https://user:secret@provider.example", "https://provider.example/?q=x", "https://provider.example/#x"])("rejects invalid endpoint %s", value => {
    expect(isOpeningProviderBaseUrl(value)).toBe(false);
  });
});
