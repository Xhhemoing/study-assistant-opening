"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ComponentProps, type MouseEvent } from "react";
import {
  SHELL_NAV_FALLBACK_MS,
  shouldScheduleShellNavFallback,
  shellNavReached,
} from "./shell-nav-link-model";

type ShellNavLinkProps = ComponentProps<typeof Link>;

/**
 * Opening shell primary navigation. Prefers next/link soft navigation, but
 * falls back to location.assign when the App Router transition stalls so the
 * sidebar <a> remains reliable even on /opening/today.
 */
export function ShellNavLink({ href, onClick, ...rest }: ShellNavLinkProps) {
  const pathname = usePathname();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hrefString = typeof href === "string" ? href : (href.pathname ?? "");

  useEffect(() => {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
  }, [pathname]);

  useEffect(() => () => {
    if (pending.current !== null) window.clearTimeout(pending.current);
  }, []);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      !shouldScheduleShellNavFallback({
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        button: event.button,
        href: hrefString,
        pathname,
      })
    ) {
      return;
    }
    if (pending.current !== null) window.clearTimeout(pending.current);
    const targetHref = hrefString;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      if (!shellNavReached(targetHref, window.location.pathname)) {
        window.location.assign(targetHref);
      }
    }, SHELL_NAV_FALLBACK_MS);
  }

  return <Link href={href} onClick={handleClick} {...rest} />;
}
