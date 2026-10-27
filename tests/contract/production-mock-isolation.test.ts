import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { allowsDemoStudyData, shouldRedirectLegacyMockPages } from "../../apps/web/src/features/opening/access-policy";
import { legacyOpeningRedirectPath } from "../../apps/web/src/middleware";

const ROOT = path.resolve(import.meta.dirname, "../..");

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

it("production never allows demo study data even when OPENING_RELEASE is off", () => {
  expect(allowsDemoStudyData({ NODE_ENV: "production", OPENING_RELEASE: "0" })).toBe(false);
  expect(shouldRedirectLegacyMockPages({ NODE_ENV: "production", OPENING_RELEASE: "" })).toBe(true);
});

it("covers retired URL aliases while keeping real Opening entries reachable", () => {
  const redirected = [
    "/learn",
    "/learn/practice/x",
    "/learn/goals",
    "/learn/goals/new",
    "/learn/exams",
    "/learn/marketplace",
    "/learn/review",
    "/learn/review/session",
    "/explore",
    "/explore/abc",
    "/preview",
    "/preview/notebook",
  ];
  for (const pathname of redirected) {
    expect(legacyOpeningRedirectPath(pathname), pathname).not.toBeNull();
  }
  expect(legacyOpeningRedirectPath("/learn/courses")).toBe("/opening/courses");
  expect(legacyOpeningRedirectPath("/learn/courses/course-1")).toBe("/opening/courses/course-1");
  expect(legacyOpeningRedirectPath("/learn/courses/course-1/edit")).toBe("/opening/courses/course-1/edit");
  expect(legacyOpeningRedirectPath("/settings/advanced")).toBe("/opening/settings/advanced");
  expect(legacyOpeningRedirectPath("/library")).toBe("/opening/library");
  expect(legacyOpeningRedirectPath("/search")).toBe("/opening/search");
  expect(legacyOpeningRedirectPath("/onboarding")).toBeNull();
  expect(legacyOpeningRedirectPath("/ui-preview")).toBe("/opening/today");
});

it("production learn course and advanced settings sources do not import mock providers", () => {
  const files = [
    "apps/web/src/features/opening/courses/course-detail.tsx",
    "apps/web/src/features/opening/settings/advanced-settings-view.tsx",
  ];
  for (const file of files) {
    const text = readSrc(file);
    expect(text, file).not.toMatch(/createMockProvider|useStudyProvider|lib\/data\/mock|resetDemoData/);
  }
});

it("keeps migrated aliases and their real-API destinations free of mock providers", () => {
  for (const name of ["library", "search", "settings"]) {
    expect(legacyOpeningRedirectPath(`/${name}`)).toBe(`/opening/${name}`);
  }
  const surfaces: Array<{ file: string; mustNotMatch: RegExp; mustMatch?: RegExp }> = [
    {
      file: "apps/web/src/app/(opening)/opening/library/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /LibraryView/,
    },
    {
      file: "apps/web/src/features/opening/search/search-workspace.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /createSearchApi/,
    },
    {
      file: "apps/web/src/app/(opening)/opening/settings/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /SettingsView/,
    },
    {
      file: "apps/web/src/app/onboarding/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /Onboarding/,
    },
  ];
  for (const surface of surfaces) {
    const text = readSrc(surface.file);
    expect(text, surface.file).not.toMatch(surface.mustNotMatch);
    if (surface.mustMatch) expect(text, surface.file).toMatch(surface.mustMatch);
  }
});

it("production course and advanced settings error paths never fall back to demo study data", () => {
  const course = readSrc("apps/web/src/features/opening/courses/course-detail.tsx");
  expect(course).toMatch(/课程内容加载失败，请重试。/);
  expect(course).toMatch(/LoadError/);
  expect(course).not.toMatch(/createMockProvider|createLegacyStudyProvider|buildSeedItems|SEED_GOAL_ID|resetDemoData/);

  const advanced = readSrc("apps/web/src/features/opening/settings/advanced-settings-view.tsx");
  expect(advanced).toMatch(/设置暂时无法读取，请重试。/);
  expect(advanced).toMatch(/demo-reset-unavailable/);
  expect(advanced).toMatch(/mock-diagnostics-unavailable/);
  expect(advanced).not.toMatch(/createMockProvider|createLegacyStudyProvider|buildSeedItems|resetDemoData/);

  const providerGate = readSrc("apps/web/src/lib/data/react.ts");
  expect(providerGate).toMatch(/process\.env\.NODE_ENV === ["']production["']/);
  expect(providerGate).toMatch(/import\(["']\.\/demo-study-provider["']\)/);
  expect(providerGate).not.toMatch(/from ["']\.\/mock\/provider["']/);
  expect(providerGate).not.toMatch(/createMockProvider/);

  const demoProvider = readSrc("apps/web/src/lib/data/demo-study-provider.ts");
  expect(demoProvider).toMatch(/createMockProvider/);
});

