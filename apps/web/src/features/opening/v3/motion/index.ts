/**
 * UI v3 动效系统入口。规则：
 * 1. 时长只用 --duration-micro/state/panel/scene，曲线只用 --ease-standard/out-expo/in/spring。
 * 2. 只动 transform / opacity；例外仅有：导航宽度、辅助区宽度、Collapse 行高、阅读器缩放宽度。
 * 3. 页面切换用 View Transitions（TransitionLink / useTransitionRouter），浏览器后退不加过渡。
 * 4. 恢复状态（刷新、重新进入）不播放庆祝或强调动画；成功反馈在服务端确认之后。
 * 5. 减少动效：系统设置或 html[data-motion=reduce] 时全部降为瞬时（tailwind.css 已统一处理）。
 */
export { TransitionLink, ViewTransitionBoundary, runViewTransition, useTransitionRouter, type NavDirection } from "./view-transition";
export { Collapse } from "./collapse";
export { usePresence } from "./use-presence";
export { useTween } from "./use-tween";
export { interactionMotionReduced, successfulInteractionHaptic } from "../../design/haptics";

/** 常用动效类名配方（字面量，便于 Tailwind 扫描） */
export const motion = {
  enter: "motion-safe:animate-enter",
  fadeIn: "motion-safe:animate-fade-in",
  pop: "motion-safe:animate-pop",
  slideIn: "motion-safe:animate-slide-in",
  settle: "motion-safe:animate-settle",
  stagger: "motion-safe:stagger",
  press: "transition-transform duration-(--duration-micro) ease-standard active:scale-[0.97] motion-reduce:active:scale-100",
  colors: "transition-colors duration-(--duration-micro) ease-standard",
} as const;
