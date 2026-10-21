export const designTokens = {
  color: {
    bg: "var(--color-bg)",
    fg: "var(--color-text)",
    accent: "var(--color-accent)",
  },
  space: {
    sm: "0.5rem",
    md: "1rem",
    lg: "1.5rem",
  },
} as const;

export {
  WorkspaceNavigation,
  getWorkspaceEntry,
  workspaceNavigationItems,
} from "./workspace-navigation";
export type {
  WorkspaceEntry,
  WorkspaceNavigationPlacement,
} from "./workspace-navigation";
export { AppShell, SIDEBAR_COLLAPSED_STORAGE_KEY } from "./app-shell";
export { getFocusTrapTarget } from "./focus-trap-model";
export type { FocusDirection } from "./focus-trap-model";
export { Card, Drawer, EmptyState, Field, StatusBadge } from "./primitives";

export { Button } from "./button";
export type { ButtonProps } from "./button";
export { CourseCover } from "./course-cover";
export type { CourseCoverProps } from "./course-cover";
export { ErrorState } from "./error-state";
export type { ErrorStateProps } from "./error-state";
export type { DrawerProps } from "./drawer";
export { LessonFocusDialog } from "./lesson-focus-dialog";
export * as Dialog from "@radix-ui/react-dialog";
export type { EmptyStateProps } from "./empty-state";
export { Skeleton, LoadingRows } from "./skeleton";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
export { Toast, ToastProvider, useToast } from "./toast";
export type { ToastMessage } from "./toast";
export { ui, tone, focusRing, fieldClass } from "./styles";
