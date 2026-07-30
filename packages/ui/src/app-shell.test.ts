import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell", () => {
  it("gives every workspace entry equal desktop and mobile navigation", () => {
    const html = renderToStaticMarkup(
      createElement(
        AppShell,
        { activeEntry: "explore", userLabel: "Lin" },
        createElement("h1", null, "自由探索"),
      ),
    );

    expect(html).toContain('data-app-shell="true"');
    expect(html).toContain('data-shell-navigation="desktop"');
    expect(html).toContain('data-shell-navigation="mobile"');
    expect(html.match(/href="\/learn"/g)).toHaveLength(2);
    expect(html.match(/href="\/explore"/g)).toHaveLength(2);
    expect(html.match(/href="\/library"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Learn"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Explore"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Library"/g)).toHaveLength(2);
    expect(html).toContain("自由探索");
    expect(html).toContain("Lin");
  });
});
