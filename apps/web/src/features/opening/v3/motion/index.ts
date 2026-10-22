/**
 * UI v3 动效系统入口。规则：
 * 1. 按用途选时长：打开/进入 --duration-enter(250)，关闭/退出 --duration-exit(150)，微交互 --duration-micro(120)，
 *    面板 --duration-panel(320)，强调时刻 --duration-emphasis(500)。开慢关快。
 * 2. 位移小、配轻微模糊：页面 8px + 3px，文字 4px + 2px。只动 transform / opacity / filter；
 *    尺寸动画例外仅有：导航宽度、辅助区宽度、Collapse 行高、阅读器缩放宽度。
 * 3. 页面切换用 View Transitions（TransitionLink / useTransitionRouter），新过渡会跳过旧过渡，连续点击不被阻塞；浏览器后退不加过渡。
 * 4. 恢复状态（刷新、重新进入）不播放庆祝或强调动画；成功反馈在服务端确认之后。
 * 5. 减少动效：系统设置或 html[data-motion=reduce] 时全部降为瞬时（tailwind.css 已统一处理）。
 */
export { TransitionLink, ViewTransitionBoundary, runIndicatorTransition, runViewTransition, useTransitionRouter, type NavDirection } from "./view-transition";
export { TextSwap, ThinkingLine, SuccessCheck, DisclosureChevron, useReplay } from "./feedback";
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
  shake: "motion-safe:animate-shake",
  textIn: "motion-safe:animate-text-in",
} as const;
