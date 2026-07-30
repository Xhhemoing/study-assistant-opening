import type { ReactNode } from "react";
import { BookOpen, Compass, Library } from "lucide-react";

export const workspaceNavigationItems = [
  { href: "/learn", label: "Learn", key: "learn" },
  { href: "/explore", label: "Explore", key: "explore" },
  { href: "/library", label: "Library", key: "library" },
] as const;

export type WorkspaceEntry = (typeof workspaceNavigationItems)[number]["key"];
export type WorkspaceNavigationPlacement = "sidebar" | "bottom";

export function getWorkspaceEntry(value: string | null | undefined): WorkspaceEntry {
  return workspaceNavigationItems.some((item) => item.key === value)
    ? (value as WorkspaceEntry)
    : "learn";
}

export function WorkspaceNavigation({
  activeEntry,
  placement = "sidebar",
  className,
}: {
  activeEntry: WorkspaceEntry;
  placement?: WorkspaceNavigationPlacement;
  className?: string;
}): ReactNode {
  const classes = ["workspace-navigation", `workspace-navigation--${placement}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <nav
      aria-label="Workspace navigation"
      className={classes}
      data-navigation-placement={placement}
    >
      {workspaceNavigationItems.map((item) => (
        <a
          key={item.key}
          href={item.href}
          aria-label={item.label}
          data-entry={item.key}
          aria-current={item.key === activeEntry ? "page" : undefined}
        >
          <span className="workspace-navigation__icon" aria-hidden="true">
            {item.key === "learn" ? (
              <BookOpen size={20} strokeWidth={1.8} />
            ) : item.key === "explore" ? (
              <Compass size={20} strokeWidth={1.8} />
            ) : (
              <Library size={20} strokeWidth={1.8} />
            )}
          </span>
          <span className="workspace-navigation__label">{item.label}</span>
        </a>
      ))}
    </nav>
  );
}
