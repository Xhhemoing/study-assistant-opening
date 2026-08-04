import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { CommandPalette } from "./command-palette";

describe("command palette accessibility", () => {
  it("exposes the open palette as a labelled modal combobox with command options", () => {
    const html = renderToStaticMarkup(createElement(CommandPalette, {
      open: true,
      onOpen: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="command-palette-title"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="command-palette-options"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="command-option-new-note"');
    expect(html).toContain('id="command-option-new-exploration"');
    expect(html).toContain('id="command-option-new-goal"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="关闭搜索"');
  });
});
