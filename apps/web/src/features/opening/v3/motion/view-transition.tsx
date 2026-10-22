"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, type ComponentProps, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { interactionMotionReduced } from "../../design/haptics";
import { navDirection } from "../shell/features";

export type NavDirection = "forward" | "back" | "swap" | "local";

type ViewTransitionHandle = { finished: Promise<void>; skipTransition: () => void };
type TransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionHandle };

let pending: (() => void) | null = null;
let active: ViewTransitionHandle | null = null;
const SETTLE_TIMEOUT_MS = 600; // 路由未在时限内提交时放行，避免冻结画面

/**
 * 连续操作不被动画阻塞：新过渡开始时直接跳过上一个（skipTransition 会立即完成 DOM 更新）。
 */
function start(direction: NavDirection, update: () => void | Promise<void>, onDone?: () => void) {
  const doc = document as TransitionDocument;
  if (!doc.startViewTransition || interactionMotionReduced()) { void Promise.resolve(update()).finally(onDone); return; }
  active?.skipTransition();
  document.documentElement.dataset.navDirection = direction;
  const transition = doc.startViewTransition(update);
  active = transition;
  void transition.finished.finally(() => {
    if (active === transition) { active = null; delete document.documentElement.dataset.navDirection; }
    onDone?.();
  });
}

/** 同页状态变化（专注切换、计划应用后重排）。默认 local：主区不淡入淡出，只有命名元素移动。 */
export function runViewTransition(update: () => void, direction: NavDirection = "local") {
  start(direction, () => { flushSync(update); });
}

/**
 * 滑动指示条（标签、分段选择）：组内当前项的指示块带 data-pill；
 * 切换前后各打一次 data-vt-pill，让它从旧位置滑到新位置。不需要测量，也不写内联样式。
 */
export function runIndicatorTransition(group: HTMLElement | null, update: () => void) {
  const clear = () => document.querySelectorAll("[data-vt-pill]").forEach(node => node.removeAttribute("data-vt-pill"));
  const mark = () => group?.querySelector("[data-pill]")?.setAttribute("data-vt-pill", "");
  clear(); mark();
  start("local", () => { clear(); flushSync(update); mark(); }, clear);
}

/** 路由跳转带过渡：等新路由提交（ViewTransitionBoundary 放行）后再截取新画面。 */
export function useTransitionRouter() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const go = useCallback((href: string, mode: "push" | "replace" = "push", direction?: NavDirection) => {
    const target = href.split("?")[0] ?? href;
    const dir = direction ?? navDirection(pathname, target);
    start(dir, () => new Promise<void>(resolve => {
      const timer = window.setTimeout(() => { pending = null; resolve(); }, SETTLE_TIMEOUT_MS);
      pending = () => { window.clearTimeout(timer); pending = null; resolve(); };
      if (mode === "replace") router.replace(href); else router.push(href);
    }));
  }, [router, pathname]);
  return { push: (href: string, direction?: NavDirection) => go(href, "push", direction), replace: (href: string) => go(href, "replace", "swap"), back: () => router.back() };
}

/** 放在壳层内：路径或查询变化提交到 DOM 后放行等待中的过渡。 */
export function ViewTransitionBoundary() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString();
  useLayoutEffect(() => { pending?.(); }, [pathname, search]);
  return null;
}

type TransitionLinkProps = ComponentProps<typeof Link> & { href: string; direction?: NavDirection; vtSource?: "object-title" };

/**
 * 站内链接统一用它：普通左键点击走带过渡的跳转；修饰键、新窗口、外链保持浏览器默认。
 * vtSource：点击时给来源元素内的 [data-vt-title] 打上共享元素标记，目标页标题平滑承接。
 */
export function TransitionLink({ href, direction, vtSource, onClick, replace, ...rest }: TransitionLinkProps) {
  const router = useTransitionRouter();
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target === "_blank") return;
    event.preventDefault();
    if (vtSource) {
      document.querySelectorAll("[data-vt-source]").forEach(node => node.removeAttribute("data-vt-source"));
      (event.currentTarget.querySelector("[data-vt-title]") ?? event.currentTarget).setAttribute("data-vt-source", vtSource);
    }
    if (replace) router.replace(href); else router.push(href, direction);
  }
  return <Link href={href} replace={replace} onClick={handle} {...rest} />;
}
