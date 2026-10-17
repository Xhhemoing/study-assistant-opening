/** Soft-nav watchdog delay before falling back to a hard assign. */
export const SHELL_NAV_FALLBACK_MS = 800;

export function shellNavPath(href: string): string {
  return href.split("?")[0] ?? href;
}

/** True when the current location has already reached the link target. */
export function shellNavReached(href: string, pathname: string): boolean {
  const target = shellNavPath(href);
  if (!target) return true;
  return pathname === target || pathname.startsWith(`${target}/`);
}

/**
 * Sidebar Links use next/link, which always preventDefault and soft-navigates
 * inside startTransition. On heavy clients (notably /opening/today with the
 * teaching pane) that transition can stall: the click hits the <a>, there is
 * no overlay/inert, yet the URL never changes and no framenavigated fires.
 *
 * Schedule a native assign only for unmodified primary clicks that still need
 * to leave the current path.
 */
export function shouldScheduleShellNavFallback(input: {
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
  href: string;
  pathname: string;
}): boolean {
  if (input.defaultPrevented) return false;
  if (input.button !== 0) return false;
  if (input.metaKey || input.ctrlKey || input.shiftKey || input.altKey) return false;
  return !shellNavReached(input.href, input.pathname);
}
