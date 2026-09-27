import path from "node:path";
import { findBlockIndex, NotionUiError, pathOf, scrub } from "./notion-ui-helpers.mjs";

export async function inspectMeetingDom(page, blockId) {
  const root = await findBlock(page, blockId);
  return [await root.evaluate((element) => {
    const text = (candidate) => (candidate?.innerText ?? candidate?.textContent ?? "").replace(/\s+/g, " ").trim();
    const visible = (candidate) => {
      if (!candidate) return false;
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    return {
      text: text(element),
      tabs: [...element.querySelectorAll('[role="tab"]')].filter(visible).map((tab) => ({
        text: text(tab),
        selected: tab.getAttribute("aria-selected") === "true",
        controls: tab.getAttribute("aria-controls"),
      })),
      panels: [...element.querySelectorAll('[role="tabpanel"]')].filter(visible).map((panel) => ({
        id: panel.id,
        labelledBy: panel.getAttribute("aria-labelledby"),
        text: panel.innerText ?? panel.textContent ?? "",
      })),
      controls: [...element.querySelectorAll('[role="button"],button')].filter(visible).map((control) => ({
        aria: control.getAttribute("aria-label"),
        text: text(control).slice(0, 160),
      })),
      audioCount: element.querySelectorAll("audio").length,
    };
  })];
}

export async function importChromium() {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new NotionUiError(`Playwright is unavailable: ${scrub(error?.message)}`, "PLAYWRIGHT_UNAVAILABLE");
  }
}

export async function findBlock(page, blockId) {
  const roots = page.locator("[data-block-id]");
  const blockIds = await roots.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-block-id")));
  const index = findBlockIndex(blockIds, blockId);
  if (index < 0) throw new NotionUiError("Meeting Notes block was not found", "BLOCK_NOT_FOUND");
  return roots.nth(index);
}

export async function closeDialogs(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dialogs = page.locator('[role="dialog"]:visible');
    if (await dialogs.count() === 0) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

export function buildBrowserContextOptions(options = {}) {
  const profilePath = options.profilePath ?? path.resolve(".tmp/notion-browser-profile");
  return {
    profilePath,
    launchOptions: {
      executablePath: options.executablePath ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: options.headless ?? true,
      viewport: options.viewport ?? { width: 1440, height: 1200 },
    },
  };
}

export async function openContext(options = {}) {
  const chromium = await importChromium();
  const settings = buildBrowserContextOptions(options);
  return chromium.launchPersistentContext(settings.profilePath, settings.launchOptions);
}

export function addSafeEvent(events, item) {
  events.push({
    t: Date.now(),
    kind: item.kind,
    method: item.method,
    path: item.path ? pathOf(item.path) : undefined,
    status: item.status,
  });
  if (events.length > 200) events.splice(0, events.length - 200);
}
