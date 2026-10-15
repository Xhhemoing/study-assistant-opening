import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import type { MaterialSpace } from "./material-spaces";
import type { MaterialMembership } from "./material-organization-client";

const state = vi.hoisted(() => ({ space: "all" as MaterialSpace, sources: [] as SourceRecord[], memberships: [] as MaterialMembership[] }));

vi.mock("./use-material-library", () => ({
  useMaterialLibrary: () => ({
    sources: state.sources,
    organization: { courses: [{ id: "course-b", title: "当前课程", archived: false }], memberships: state.memberships },
    space: state.space,
    selection: new Set(),
    loading: false,
    refreshing: false,
    busy: false,
    organizationReady: true,
    error: "",
    organizationError: "",
    result: null,
    changeSpace: vi.fn(),
    createCourse: vi.fn(),
    refresh: vi.fn(),
    load: vi.fn(),
    toggle: vi.fn(),
    togglePage: vi.fn(),
  }),
}));

vi.mock("../inbox/inbox-panel", () => ({
  InboxPanel: ({ courseId }: { courseId: string | null }) => createElement("div", { "data-upload-course": courseId ?? "none" }),
}));

import { MaterialLibrary } from "./material-library";

beforeEach(() => { state.space = "all"; state.sources = []; state.memberships = []; });

it.each([
  { space: "course:course-b", expected: "course-b" },
  { space: "all", expected: "none" },
  { space: "inbox", expected: "none" },
] as const)("uses the currently displayed $space for upload assignment instead of the entry course", ({ space, expected }) => {
  state.space = space;
  const html = renderToStaticMarkup(createElement(MaterialLibrary, { api: {} as OpeningApi, courseId: "course-a" }));
  expect(html).toContain(`data-upload-course="${expected}"`);
});

it("keeps processing and failure counts scoped to the displayed course", () => {
  state.space = "course:course-b";
  const source = (id: string, uploadState: SourceRecord["uploadState"], parseState: SourceRecord["parseState"]): SourceRecord => ({
    id, workspaceId: "workspace", name: `${id}.pdf`, mime: "application/pdf", bytes: 1,
    sha256: "ab".repeat(32), version: 0, uploadState, parseState, error: null, createdAt: "2026-10-15T00:00:00Z",
  });
  state.sources = [
    source("local-pending", "pending", "not_started"), source("local-parsing", "uploaded", "running"), source("local-failed", "uploaded", "failed"),
    source("other-pending", "pending", "not_started"), source("other-parsing", "uploaded", "running"), source("other-failed", "uploaded", "failed"),
  ];
  state.memberships = state.sources.filter(item => item.id.startsWith("local-")).map(item => ({ courseId: "course-b", sourceId: item.id, role: "reference" }));
  const html = renderToStaticMarkup(createElement(MaterialLibrary, { api: {} as OpeningApi }));
  for (const label of ["份上传未完成", "份正在解析", "份需处理"]) {
    expect(html).toContain(`1 ${label}`);
    expect(html).not.toContain(`2 ${label}`);
  }
});
