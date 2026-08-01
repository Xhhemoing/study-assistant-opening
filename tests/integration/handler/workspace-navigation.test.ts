import { describe, expect, it } from "vitest";
import { renderWorkspaceNavigation } from "../../../apps/web/src/features/workspace/navigation";

describe("workspace navigation handler rendering", () => {
  it("renders all workspace entries with the active entry", () => {
    const html = renderWorkspaceNavigation("learn");

    expect(html).toContain('aria-label="Workspace navigation"');
    expect(html).toContain('href="/learn"');
    expect(html).toContain('href="/explore"');
    expect(html).toContain('href="/library"');
    expect(html).toContain('data-entry="learn" aria-current="page"');
  });
});