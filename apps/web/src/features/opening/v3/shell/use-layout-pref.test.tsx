// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { normalizeLayoutPref, useLayoutPref } from "./use-layout-pref";

it("ignores valid old visual choices while preserving navigation and saved split layouts", () => {
  const splitLayouts = { notes: { main: 60, notes: 40 } };
  expect(normalizeLayoutPref({ skin: "glass", density: "comfortable", corner: "crisp", navWidth: 240, nav: "compact", split: ["notes"], splitLayouts }))
    .toMatchObject({ skin: "frost", density: "compact", corner: "round", navWidth: 208, nav: "compact", split: ["notes"], splitLayouts });
});

it("does not rewrite storage on load and saves only the remaining layout choices", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const old = JSON.stringify({ skin: "glass", density: "comfortable", corner: "crisp", navWidth: 245, nav: "compact", split: ["notes"], splitLayouts: { notes: { main: 60, notes: 40 } } });
  localStorage.setItem("aistudy.layout.v1", old);
  const host = document.createElement("div"), root = createRoot(host);
  function Probe() {
    const [pref, update] = useLayoutPref();
    return <button onClick={() => update({ nav: "expanded" })}>{pref.nav} {pref.skin} {pref.navWidth}</button>;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("compact frost 208");
    expect(localStorage.getItem("aistudy.layout.v1")).toBe(old);
    await act(async () => host.querySelector("button")!.click());
    expect(JSON.parse(localStorage.getItem("aistudy.layout.v1")!)).toEqual({ nav: "expanded", split: ["notes"], splitLayouts: { notes: { main: 60, notes: 40 } } });
  } finally { await act(async () => root.unmount()); localStorage.clear(); vi.unstubAllGlobals(); }
});
