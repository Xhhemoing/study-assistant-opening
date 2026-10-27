import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  permanentRedirect: (href: string) => { throw new Error(href); },
}));
vi.mock("./ai-settings-panel", () => ({ AiSettingsPanel: () => null }));
vi.mock("./provider-settings-panel", () => ({ ProviderSettingsPanel: () => null }));
vi.mock("../guidance-settings/guidance-mode-picker", () => ({ GuidanceModePicker: () => null }));

import { AdvancedSettingsView } from "./advanced-settings-view";
import OpeningAdvancedSettingsPage from "../../../app/(opening)/opening/settings/advanced/page";

it("keeps advanced settings back and export actions inside the Opening workspace", () => {
  const html = renderToStaticMarkup(createElement(AdvancedSettingsView, { basePath: "/opening/settings" }));
  expect(html).toContain('href="/opening/settings"');
  expect(html).toContain('href="/opening/settings/export"');
  expect(html).not.toContain('href="/settings"');
  expect(html).not.toContain('href="/settings/export"');
});

it("redirects the retired advanced route to AI settings while preserving repeated query values", async () => {
  await expect(OpeningAdvancedSettingsPage({ searchParams: Promise.resolve({ model: "one", tag: ["a", "b"] }) }))
    .rejects.toThrow("/opening/settings/ai?model=one&tag=a&tag=b");
});
