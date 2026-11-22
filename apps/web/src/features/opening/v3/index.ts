/** Opening v3 的壳层、视图组件与动效。 */
export * from "./motion";
export * from "./ui";
export { AppShell, MobileHeaderTools, type RecentThread } from "./shell/app-shell";
export { PageHeader, LocationLine, ListPage, type LocationSegment } from "./shell/page-header";
export { FEATURES, NAV_CORE, NAV_TOOLS, NAV_SYSTEM, SETTINGS_PAGES, resolveFeature, featureHref, activeNavId, navDirection, type Feature } from "./shell/features";
export { FEATURE_ICONS } from "./shell/icons";
export { useLayoutPref, type LayoutPref, type Skin, type Density, type Corner } from "./shell/use-layout-pref";
export { TopBar, TopBarTools } from "./shell/top-bar";
export { SplitView, SplitControls, type SplitPanes, type SplitPaneSpec } from "./workspace/split-view";
export { StartComposer, type Suggestion, type ContextChip } from "./start/start-composer";
export { SessionSummary, type SummaryCounts } from "./learning/session-summary";
