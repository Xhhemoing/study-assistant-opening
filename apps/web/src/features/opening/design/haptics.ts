/** The root attribute includes the user's choice; the media query also covers pre-hydration. */
export function interactionMotionReduced(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return true;
  return document.documentElement.dataset.motion === "reduce"
    || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** Call once after a confirmed success, never at the start of a request or on restoration. */
export function successfulInteractionHaptic(): void {
  if (interactionMotionReduced() || document.visibilityState === "hidden" || typeof navigator.vibrate !== "function") return;
  try { navigator.vibrate(8); }
  catch { /* Optional device feedback must never change a successful operation's outcome. */ }
}
