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

it("covers old mock URL aliases with redirects while keeping /learn/courses*", () => {
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
  expect(legacyOpeningRedirectPath("/learn/courses")).toBeNull();
  expect(legacyOpeningRedirectPath("/learn/courses/course-1")).toBeNull();
  expect(legacyOpeningRedirectPath("/learn/courses/course-1/edit")).toBeNull();
  expect(legacyOpeningRedirectPath("/settings/advanced")).toBeNull();
  expect(legacyOpeningRedirectPath("/library")).toBeNull();
  expect(legacyOpeningRedirectPath("/search")).toBeNull();
  expect(legacyOpeningRedirectPath("/onboarding")).toBeNull();
  expect(legacyOpeningRedirectPath("/ui-preview")).toBeNull();
});

it("production learn course and advanced settings sources do not import mock providers", () => {
  const files = [
    "apps/web/src/app/(workspace)/learn/courses/[id]/page.tsx",
    "apps/web/src/features/courses/legacy-course-detail.tsx",
    "apps/web/src/features/settings/advanced-settings-view.tsx",
    "apps/web/src/app/(workspace)/settings/advanced/page.tsx",
  ];
  for (const file of files) {
    const text = readSrc(file);
    expect(text, file).not.toMatch(/createMockProvider|useStudyProvider|lib\/data\/mock|resetDemoData/);
  }
});

it("documents previously unchecked surfaces as real-API or static (no mock provider)", () => {
  const surfaces: Array<{ file: string; mustNotMatch: RegExp; mustMatch?: RegExp }> = [
    {
      file: "apps/web/src/app/(workspace)/library/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /LibraryView/,
    },
    {
      file: "apps/web/src/app/(workspace)/search/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /createSearchApi/,
    },
    {
      file: "apps/web/src/app/(workspace)/settings/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /SettingsView/,
    },
    {
      file: "apps/web/src/app/onboarding/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
      mustMatch: /Onboarding/,
    },
    {
      file: "apps/web/src/app/ui-preview/page.tsx",
      mustNotMatch: /createMockProvider|useStudyProvider|lib\/data\/mock/,
    },
  ];
  for (const surface of surfaces) {
    const text = readSrc(surface.file);
    expect(text, surface.file).not.toMatch(surface.mustNotMatch);
    if (surface.mustMatch) expect(text, surface.file).toMatch(surface.mustMatch);
  }
});

it("production course and advanced settings error paths never fall back to demo study data", () => {
  const course = readSrc("apps/web/src/features/courses/course-detail.tsx");
  expect(course).toMatch(/课程内容加载失败，请重试。/);
  expect(course).toMatch(/LoadError/);
  expect(course).not.toMatch(/createMockProvider|createLegacyStudyProvider|buildSeedItems|SEED_GOAL_ID|resetDemoData/);

  const advanced = readSrc("apps/web/src/features/settings/advanced-settings-view.tsx");
  expect(advanced).toMatch(/设置暂时无法读取，请重试。/);
  expect(advanced).toMatch(/demo-reset-unavailable/);
  expect(advanced).toMatch(/mock-diagnostics-unavailable/);
  expect(advanced).not.toMatch(/createMockProvider|createLegacyStudyProvider|buildSeedItems|resetDemoData/);

  const providerGate = readSrc("apps/web/src/lib/data/react.ts");
  expect(providerGate).toMatch(/Demo study provider is unavailable in production/);
  expect(providerGate).toMatch(/allowsDemoStudyData/);
});
