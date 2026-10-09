import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../../lib/data/react", () => ({ useStudyProvider: () => null }));
vi.mock("./dingtalk-connections-panel", () => ({
  DingTalkConnectionsPanel: () => createElement("div", { "data-testid": "dingtalk" }),
}));
vi.mock("../opening/timetable/semester-settings-form", () => ({
  SemesterSettingsForm: () => createElement("div", { "data-testid": "semester" }),
}));
vi.mock("../opening/timetable/timetable-import", () => ({
  TimetableImport: () => createElement("div", { "data-testid": "timetable" }),
}));
vi.mock("./ai-settings-panel", () => ({
  AiSettingsPanel: () => createElement("div", { "data-testid": "ai" }),
}));
vi.mock("./provider-settings-panel", () => ({
  ProviderSettingsPanel: () => createElement("div", { "data-testid": "provider" }),
}));
vi.mock("./diagnostics-panel", () => ({
  DiagnosticsPanel: () => createElement("div", { "data-testid": "diagnostics" }),
}));
vi.mock("../guidance-settings/guidance-mode-picker", () => ({
  GuidanceModePicker: () => createElement("div", { "data-testid": "autonomy" }),
}));

import { SettingsView } from "./settings-view";
import { AdvancedSettingsView } from "./advanced-settings-view";

describe("settings page split structure", () => {
  it("keeps loop anchors on main and links advanced elsewhere", () => {
    const html = renderToStaticMarkup(createElement(SettingsView));
    expect(html).toContain('href="#connections"');
    expect(html).toContain('href="#planning"');
    expect(html).toContain('href="#preferences"');
    expect(html).toContain('id="connections"');
    expect(html).toContain('id="planning"');
    expect(html).toContain('id="preferences"');
    expect(html).toContain('href="/settings/advanced"');
    expect(html).not.toContain("data-advanced-section");
    expect(html).not.toContain("更多 / 高级");
  });

  it("renders advanced page with back link and heading", () => {
    const html = renderToStaticMarkup(createElement(AdvancedSettingsView));
    expect(html).toContain("高级设置");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("返回设置");
    expect(html).toContain('data-testid="ai"');
    expect(html).toContain('data-testid="provider"');
  });
});
