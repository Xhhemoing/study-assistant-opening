"use client";

import type { ComponentProps } from "react";
import Link from "next/link";

type ShellNavLinkProps = ComponentProps<typeof Link>;

/** Keep the shared shell mounted when changing learning surfaces.
 * Next Link preserves modified-click and caller cancellation semantics without
 * a fallback timer that could redirect after a later navigation has completed.
 */
export function ShellNavLink(props: ShellNavLinkProps) {
  return <Link {...props} />;
}
