// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CoursePanel, CourseTabs } from "./course-tabs";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState(null, "", "/opening/courses/course?tab=overview");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

function RouterHarness({ children }: { children: ReactNode }) {
  const [search, setSearch] = useState(window.location.search);
  return createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
    createElement("a", { href: "?tab=units", onClick: (event: React.MouseEvent) => {
      event.preventDefault(); window.history.pushState(null, "", "?tab=units"); setSearch(window.location.search);
    } }, "全部单元与学习目录"), children);
}

it("follows App Router search updates and real history without remounting course drafts", async () => {
  await act(async () => root.render(createElement(RouterHarness, { children:
    createElement(CourseTabs, { courseId: "course", children: [
      createElement(CoursePanel, { key: "overview", name: "overview", children: createElement("input", { "aria-label": "课程草稿", defaultValue: "原稿" }) }),
      createElement(CoursePanel, { key: "units", name: "units", children: "完整学习目录" }),
      createElement(CoursePanel, { key: "notes", name: "notes", children: createElement("textarea", { "aria-label": "笔记草稿", defaultValue: "未保存笔记" }) }),
    ] }) })));
  const draft = host.querySelector("input")!;
  draft.value = "刚刚写到这里";
  await act(async () => host.querySelector<HTMLAnchorElement>('a[href="?tab=units"]')!.click());
  expect(window.location.search).toBe("?tab=units");
  expect(host.querySelector('section[aria-label="单元"]')?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector('section[aria-label="学习"]')?.hasAttribute("hidden")).toBe(true);
  expect(host.querySelector("input")).toBe(draft);
  expect(draft.value).toBe("刚刚写到这里");
  await act(async () => host.querySelector<HTMLAnchorElement>('nav a[href*="tab=notes"]')!.click());
  const note = host.querySelector("textarea")!; note.value = "继续写笔记";
  await act(async () => {
    window.history.replaceState(null, "", "?tab=overview");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(host.querySelector('section[aria-label="学习"]')?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector("input")).toBe(draft);
  expect(host.querySelector("textarea")).toBe(note);
  expect(note.value).toBe("继续写笔记");
});
