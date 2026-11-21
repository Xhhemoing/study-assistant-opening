// @vitest-environment jsdom
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChallengeSheet } from "./challenge-sheet";

const load = createRequire(import.meta.url);
// These tools can be supplied via NODE_PATH without changing the shared workspace install.
function hasTestingLibrary() {
  try {
    load.resolve("@testing-library/dom");
    load.resolve("@testing-library/user-event");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    return false;
  }
}
it.skipIf(!hasTestingLibrary())("completes the public challenge with Tab, arrow keys, Space and Enter", async () => {
  const { within } = load("@testing-library/dom");
  const { userEvent } = load("@testing-library/user-event");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom lacks CSS.escape; user-event uses it in a quoted radio-name selector.
  vi.stubGlobal("CSS", { escape: (name: string) => name.replace(/["\\]/g, "\\$&") });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(() => root.render(<ChallengeSheet entry="/login" />));
    const screen = within(host);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "选择题目" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "开始计时" }));
    await act(() => user.keyboard("{Enter}"));
    await user.tab();
    await user.tab();
    const steps = screen.getByRole("group", { name: "哪一步出了错？" });
    expect(document.activeElement).toBe(within(steps).getAllByRole("radio")[0]);
    await act(() => user.keyboard("{ArrowDown}{ArrowDown}"));
    expect(within(steps).getAllByRole("radio")[2].checked).toBe(true);
    await user.tab();
    await act(() => user.keyboard(" "));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "核对答案" }));
    await act(() => user.keyboard("{Enter}"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "错因诊断预览" }));
    expect(screen.getByText("步骤和原因都找对了。")).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "使用已有账号登录" }));
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
