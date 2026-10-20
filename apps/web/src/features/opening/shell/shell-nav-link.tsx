"use client";

import type { ComponentProps } from "react";

type ShellNavLinkProps = ComponentProps<"a">;

/** Primary shell navigation deliberately uses native navigation.
 * App Router transitions can stall behind concurrent teaching updates. A native
 * anchor avoids that interception entirely, as well as stale fallback timers
 * racing subsequent clicks. Browser modifier keys and cancelled clicks retain
 * their normal semantics. Page-level learning routes may still use soft nav.
 */
export function ShellNavLink(props: ShellNavLinkProps) {
  return <a {...props} />;
}
