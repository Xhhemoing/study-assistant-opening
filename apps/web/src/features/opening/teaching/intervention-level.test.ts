import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DEFAULT_OPENING_INTERVENTION_PREFS } from "@aistudy/contracts";
import { interventionLevel, withInterventionLevel, PreferenceControlsView } from "./preference-controls";

it("shows three levels while preserving old detailed preferences until the user changes a level", () => {
  const original = { ...DEFAULT_OPENING_INTERVENTION_PREFS, proactivity: "minimal" as const, depth: "hint_only" as const };
  expect(interventionLevel(original)).toBe("balanced");
  expect(original.proactivity).toBe("minimal");
  const next = withInterventionLevel(original, "active");
  expect(next).toEqual({ ...original, proactivity: "high", quietMode: false });
  expect(next.nodes).toBe(original.nodes);
  expect(withInterventionLevel(original, "quiet")).toEqual({ ...original, proactivity: "off", quietMode: true });
});

it("uses one three-option input without losing reset and effective-layer information", () => {
  const data = { settings: DEFAULT_OPENING_INTERVENTION_PREFS, effective: DEFAULT_OPENING_INTERVENTION_PREFS, courseOverride: null, sessionOverride: null };
  const html = renderToStaticMarkup(createElement(PreferenceControlsView, {
    simplified: true, scope: "global", data, draft: data.settings, busy: false, onDraftChange() {}, onSave() {}, onReset() {}, onReload() {},
  }));
  expect((html.match(/<select/g) ?? []).length).toBe(1);
  expect((html.match(/<option/g) ?? []).length).toBe(3);
  for (const label of ["安静", "适中", "积极", "重置为默认", "全局偏好"]) expect(html).toContain(label);
  expect(html).not.toContain('type="checkbox"');
});
