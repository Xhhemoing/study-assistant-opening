/**
 * View preferences choose *how* an artifact is shown. They never touch content or
 * its revision, so toggling text-only cannot discard a reader's edited parameters.
 */
import type { DisplayMode } from "./capability";

export type ViewPrefs = {
  /** Reader asked for prose only ("不要图", terminal host, export). */
  textOnly?: boolean;
  /** Passed through to renderers (no autoplay, keyframes); does not change the mode. */
  reducedMotion?: boolean;
  /** Host default when the reader expressed nothing; falls back down the ladder. */
  preferredMode?: DisplayMode;
};

const LADDER: readonly DisplayMode[] = ["interactive", "static", "text"];

export function resolveDisplayMode(supported: readonly DisplayMode[], prefs: ViewPrefs = {}): DisplayMode {
  if (prefs.textOnly) return "text";
  const start = LADDER.indexOf(prefs.preferredMode ?? "interactive");
  for (const mode of LADDER.slice(start)) {
    if (supported.includes(mode)) return mode;
  }
  return "text";
}
