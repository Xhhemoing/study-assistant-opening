// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ObjectConversationContext } from "../opening/assistant/conversation-object-context";
import type { CourseAsset } from "./course-model";
import { CourseAssets, CourseContents, CourseMediaSection } from "./course-detail";

const conversation = "11111111-1111-4111-8111-111111111111", note = "22222222-2222-4222-8222-222222222222", source = "33333333-3333-4333-8333-333333333333";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement("a", { ...props, href }, children) }));
vi.mock("../opening/client/api", () => ({ createOpeningApi: () => ({ listSources: async () => [{ id: "33333333-3333-4333-8333-333333333333", version: 7 }] }) }));
vi.mock("../opening/settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
const assets: CourseAsset[] = [
  { id: "document-asset", assetType: "document", assetId: note, role: "primary", sortOrder: 0, document: { id: note, title: "原笔记", updatedAt: "2026-10-22T08:00:00Z" } },
  { id: "source-asset", assetType: "source", assetId: source, role: "reference", sortOrder: 1, source: { id: source, name: "原材料" } },
];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("preserves original material identity, note anchors and course filters while carrying only the original conversation", async () => {
  await act(async () => root.render(createElement(ObjectConversationContext.Provider, { value: conversation },
    createElement(CourseContents, { courseId: "course / 1", assets }),
    createElement(CourseAssets, { courseId: "course / 1", assets, onRemoved: () => undefined, libraryHref: "/opening/library?tab=notes&courseId=course%20%2F%201" }),
    createElement(CourseMediaSection, { assets, libraryMaterialsHref: "/opening/library?tab=materials&courseId=course%20%2F%201" }),
  )));
  const hrefs = [...host.querySelectorAll("a")].map(link => link.getAttribute("href"));
  expect(hrefs).toContain(`/opening/library/${note}?conversation=${conversation}`);
  const material = new URL(hrefs.find(href => href?.includes(`source=${source}`))!, "https://study.invalid");
  expect(Object.fromEntries(material.searchParams)).toEqual({ tab: "materials", source, version: "7", conversation });
  expect(hrefs).toContain(`/opening/library?tab=notes&courseId=course+%2F+1&conversation=${conversation}#document-${note}`);
  expect(hrefs.filter(href => href === `/opening/library?tab=materials&courseId=course+%2F+1&conversation=${conversation}`)).toHaveLength(1);
  expect(hrefs).toContain("#course-assets");
});

it("does not append conversation references to the legacy library URL", async () => {
  await act(async () => root.render(createElement(ObjectConversationContext.Provider, { value: conversation }, createElement(CourseAssets, { courseId: "course", assets: [assets[0]!], onRemoved: () => undefined, libraryHref: "/library?tab=notes" }))));
  expect(host.querySelector("a")?.getAttribute("href")).toBe(`/library?tab=notes#document-${note}`);
});
