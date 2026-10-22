import {
  BookOpen, CalendarClock, FileDown, FolderOpen, Gauge, Layers, MessageSquare, Plug, Plus, RotateCcw, Search,
  Settings, SlidersHorizontal, Sparkles, SquareFunction, Target, Upload, type LucideIcon,
} from "lucide-react";
import type { FeatureIcon } from "./features";

/** 图标集中映射：功能注册表只写语义名，图标库升级时只改这里。 */
export const FEATURE_ICONS: Record<FeatureIcon, LucideIcon> = {
  start: Sparkles, courses: BookOpen, review: RotateCcw, library: FolderOpen, sprint: CalendarClock, cards: Layers,
  search: Search, settings: Settings, assistant: MessageSquare, add: Plus, exam: Target, upload: Upload,
  connections: Plug, export: FileDown, advanced: SlidersHorizontal, measure: Gauge, canvas: SquareFunction,
};
