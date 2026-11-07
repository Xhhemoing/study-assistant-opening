// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { preAnswerConfidenceSchema } from "@aistudy/contracts";
import { ConfidenceChoice, confidenceOptions } from "./confidence-choice";
import type { PreAnswerConfidence } from "./model";

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { vi.unstubAllGlobals(); });

it("maps each label to its contract value, clears on a second press and locks when disabled", () => {
  expect(confidenceOptions.map(option => option.value)).toEqual(preAnswerConfidenceSchema.options);
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const onChange = vi.fn();
  const render = (value: PreAnswerConfidence | null, disabled = false) => act(() => root.render(<ConfidenceChoice value={value} disabled={disabled} onChange={onChange} />));
  const buttons = () => [...host.querySelectorAll("button")];
  const button = (label: string) => buttons().find(node => node.textContent === label)!;
  try {
    render(null);
    expect(host.querySelector("[role='group']")?.getAttribute("aria-label")).toBe("作答前的把握");
    for (const [label, value] of [["没把握", "not_confident"], ["有点把握", "somewhat_confident"], ["有把握", "confident"]] as const) {
      act(() => button(label).click());
      expect(onChange).toHaveBeenLastCalledWith(value);
    }
    expect(buttons().map(node => node.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    render("somewhat_confident");
    expect(buttons().map(node => node.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    act(() => button("有点把握").click());
    expect(onChange).toHaveBeenLastCalledWith(null);
    render("somewhat_confident", true);
    expect(buttons().every(node => node.disabled)).toBe(true);
    expect(button("有点把握").getAttribute("aria-pressed")).toBe("true");
  } finally { act(() => root.unmount()); host.remove(); }
});
