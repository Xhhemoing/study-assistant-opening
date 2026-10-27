import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./dingtalk-connections-panel", () => ({
  DingTalkConnectionsPanel: () => createElement("div", { "data-testid": "dingtalk" }),
}));
vi.mock("../timetable/semester-settings-form", () => ({
  SemesterSettingsForm: () => createElement("div", { "data-testid": "semester" }),
}));
vi.mock("../timetable/timetable-import", () => ({
  TimetableImport: () => createElement("div", { "data-testid": "timetable" }),
}));
vi.mock("../teaching/preference-controls", () => ({
  PreferenceControls: () => createElement("div", { "data-testid": "intervention-prefs" }),
}));
vi.mock("./ai-settings-panel", () => ({
  AiSettingsPanel: () => createElement("div", { "data-testid": "ai" }),
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
  it("keeps three real setting pages and puts only appearance on the default page", () => {
    const html = renderToStaticMarkup(createElement(SettingsView));
    for (const href of ["/settings", "/settings/learning", "/settings/ai"]) expect(html).toContain(`href="${href}"`);
    expect(html).toContain("外观"); expect(html).toContain("学习"); expect(html).toContain("AI 与数据");
    expect(html).not.toContain('id="preferences"');
    expect(html).not.toContain('id="quick-model-setup"');
    const learning = renderToStaticMarkup(createElement(SettingsView, { section: "learning" }));
    expect(learning).toContain('id="preferences"');
    expect(learning).toContain('data-testid="intervention-prefs"');
    expect(learning).toContain('data-testid="semester"');
    expect(learning).toContain('data-testid="timetable"');
  });
  it("renders advanced page with back link, AI panels, and collapsed folds", () => {
    const html = renderToStaticMarkup(createElement(AdvancedSettingsView));
    expect(html).toContain("高级设置");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("返回设置");
    expect(html).toContain('data-testid="ai"');
    expect(html).toContain('data-advanced-fold="entry-explore"');
    expect(html).toContain('data-advanced-fold="export"');
    expect(html).toContain('data-advanced-fold="danger"');
    expect(html).toContain('data-advanced-fold="developer"');
    expect(html).toContain("默认入口");
    expect(html).toContain("导出与备份");
    expect(html).toContain("危险操作");
    expect(html).toContain("开发者");
    expect(html).toContain('data-testid="demo-reset-unavailable"');
    expect(html).toContain('data-testid="mock-diagnostics-unavailable"');
    expect(html).not.toContain("重置演示数据");
    // explore soft-demotion copy lives inside the loaded entry form (client fetch)
    expect(html).toContain('href="/settings/export"');
  });

  it("keeps advanced settings links inside the Opening shell when reused there", () => {
    const html = renderToStaticMarkup(createElement(SettingsView, { basePath: "/opening/settings" }));
    expect(html).toContain('href="/opening/settings/learning"');
    expect(html).toContain('href="/opening/settings/ai"');
    expect(html).not.toContain('href="/settings/advanced');
  });
});
