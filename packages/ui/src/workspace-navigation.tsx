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
  const classes = ["flex gap-1", placement === "bottom" ? "justify-around px-2" : "flex-col px-2", className]
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
          className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-[10px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 motion-reduce:transition-none ${item.key === activeEntry ? "bg-emerald-50 text-emerald-800" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"}`}
          data-entry={item.key}
          aria-current={item.key === activeEntry ? "page" : undefined}
        >
          <span className="shrink-0" aria-hidden="true">
            {item.key === "learn" ? (
              <BookOpen size={20} strokeWidth={1.8} />
            ) : item.key === "explore" ? (
              <Compass size={20} strokeWidth={1.8} />
            ) : (
              <Library size={20} strokeWidth={1.8} />
            )}
          </span>
          <span className="truncate">{item.label}</span>
        </a>
      ))}
    </nav>
  );
}
