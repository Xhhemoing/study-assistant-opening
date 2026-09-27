import {
  assertSafeTarget,
  cleanTranscriptForArtifact,
  isNativeTranscriptGate,
  NotionUiError,
  scrub,
  writeTranscriptArtifactAtomic,
} from "./notion-ui-helpers.mjs";
import { closeDialogs, findBlock, openContext } from "./notion-ui-browser.mjs";

async function readTranscriptObservation(page, blockId) {
  return page.evaluate(({ blockId: id }) => {
    const textOf = (element) => element?.innerText ?? element?.textContent ?? "";
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const roots = [...document.querySelectorAll("[data-block-id]")]
      .filter((element) => element.getAttribute("data-block-id") === id);
    const tabs = roots.flatMap((root) => [...root.querySelectorAll('[role="tab"]')]).filter(visible);
    const transcriptTabs = tabs.filter((element) => textOf(element).replace(/\s+/g, " ").trim() === "Transcript");
    const selectedTranscript = transcriptTabs.some((element) => (
      element.getAttribute("aria-selected") === "true"
      || element.getAttribute("data-state") === "active"
      || element.getAttribute("aria-current") === "page"
    ));
    const selectedTab = transcriptTabs.find((element) => (
      element.getAttribute("aria-selected") === "true"
      || element.getAttribute("data-state") === "active"
      || element.getAttribute("aria-current") === "page"
    ));
    const controlledPanelId = selectedTab?.getAttribute("aria-controls");
    const panels = roots.flatMap((root) => [...root.querySelectorAll('[role="tabpanel"]')]).filter(visible);
    const transcriptPanels = panels.filter((element) => (
      (controlledPanelId && element.id === controlledPanelId)
      || /transcript/i.test(element.id ?? "")
      || /transcript/i.test(element.getAttribute("aria-labelledby") ?? "")
    ));
    return {
      selectedTranscript,
      transcriptText: transcriptPanels.map(textOf).join("\n"),
      panelCount: transcriptPanels.length,
    };
  }, { blockId });
}

export async function verifyNativeTranscript({
  pageUrl,
  blockId,
  sourceDurationSeconds,
  manifest,
  browserOptions = {},
  artifactPath,
  allowNonDisposable = false,
  allowRealTarget = false,
} = {}) {
  assertSafeTarget({ pageUrl, blockId, allowNonDisposable, allowRealTarget });
  let context = null;
  try {
    context = await openContext(browserOptions);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: browserOptions.navigationTimeoutMs ?? 60_000 });
    await page.waitForTimeout(browserOptions.settleMs ?? 8_000);
    await closeDialogs(page);
    let root = await findBlock(page, blockId);
    const tab = root.getByRole("tab", { name: "Transcript", exact: true }).last();
    if (await tab.count() !== 1) throw new NotionUiError("native Transcript tab is unavailable", "TRANSCRIPT_TAB_MISSING");
    await tab.click({ force: true });
    let observation = null;
    const deadline = Date.now() + (browserOptions.verifyTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      await page.waitForTimeout(browserOptions.pollMs ?? 500);
      // Reacquire after every render; the original locator can be detached.
      root = await findBlock(page, blockId);
      observation = await readTranscriptObservation(page, blockId);
      const gate = isNativeTranscriptGate({
        selectedTranscript: observation.selectedTranscript,
        transcriptText: observation.transcriptText,
        sourceDurationSeconds,
      });
      if (!gate.accepted) continue;
      const cleaned = cleanTranscriptForArtifact(observation.transcriptText);
      const artifact = artifactPath ? await writeTranscriptArtifactAtomic(artifactPath, cleaned) : null;
      if (manifest) {
        manifest.stage = "verified";
        manifest.verification = {
          accepted: true,
          chars: gate.chars,
          words: gate.words,
          timestampCount: gate.timestampCount,
          firstTimestampSeconds: gate.firstTimestampSeconds,
          lastTimestampSeconds: gate.lastTimestampSeconds,
          tailGapSeconds: gate.tailGapSeconds,
          artifactPath: artifactPath ?? null,
          artifactBytes: artifact?.bytes ?? null,
          artifactSha256: artifact?.sha256 ?? null,
          verifiedAt: new Date().toISOString(),
        };
      }
      return { ...gate, artifactPath: artifactPath ?? null, artifact };
    }
    const gate = isNativeTranscriptGate({
      selectedTranscript: observation?.selectedTranscript,
      transcriptText: observation?.transcriptText,
      sourceDurationSeconds,
    });
    throw new NotionUiError(
      `native Transcript acceptance failed (readable=${gate.readable}, coverage=${gate.coverageAccepted})`,
      "TRANSCRIPT_NOT_ACCEPTED",
    );
  } catch (error) {
    throw error instanceof NotionUiError ? error : new NotionUiError(`Transcript verification failed: ${scrub(error?.message)}`);
  } finally {
    await context?.close();
  }
}
