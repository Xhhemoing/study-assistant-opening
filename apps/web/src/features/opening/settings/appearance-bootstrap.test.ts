import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { appearanceBootstrap } from "./appearance-bootstrap";

describe("appearance before hydration", () => {
  it.each([
    ["dark", false, "dark"], ["light", true, "light"], ["system", true, "dark"],
    ["system", false, "light"], ["invalid", true, "dark"],
  ])("uses stored %s and system dark=%s", (theme, dark, expected) => {
    const dom = new JSDOM("<!doctype html><html></html>", { url: "https://study.test", runScripts: "outside-only" });
    dom.window.localStorage.setItem("aistudy.appearance.v1", JSON.stringify({ version: 1, preferences: { theme, readingFont: "sans" } }));
    Object.defineProperty(dom.window, "matchMedia", { value: (query: string) => ({ matches: query.includes("dark") && dark }) });
    dom.window.eval(appearanceBootstrap);
    expect(dom.window.document.documentElement.dataset.theme).toBe(expected);
    expect(dom.window.document.documentElement.dataset.readingFont).toBe("sans");
    dom.window.close();
  });

  it("still follows the system when storage is unavailable", () => {
    const dom = new JSDOM("<!doctype html><html></html>", { runScripts: "outside-only" });
    Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true }) });
    dom.window.eval(appearanceBootstrap);
    expect(dom.window.document.documentElement.dataset.theme).toBe("dark");
    expect(dom.window.document.documentElement.dataset.motion).toBe("reduce");
    dom.window.close();
  });
});
