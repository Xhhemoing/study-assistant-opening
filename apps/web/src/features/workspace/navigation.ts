import { workspaceNavigationItems, type WorkspaceEntry } from "@aistudy/ui";

export function renderWorkspaceNavigation(activeEntry: WorkspaceEntry): string {
  const links = workspaceNavigationItems
    .map((item) => {
      const current = item.key === activeEntry ? ' aria-current="page"' : "";
      return `<a href="${item.href}" data-entry="${item.key}"${current}>${item.label}</a>`;
    })
    .join("");

  return `<nav aria-label="Workspace navigation" data-navigation-placement="sidebar">${links}</nav>`;
}
