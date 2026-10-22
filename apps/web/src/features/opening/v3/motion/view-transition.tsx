"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, type ComponentProps, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { interactionMotionReduced } from "../../design/haptics";
import { navDirection } from "../shell/features";

export type NavDirection = "forward" | "back" | "swap";

type TransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> } };

let pending: (() => void) | null = null;
const SETTLE_TIMEOUT_MS = 600; // 路由未在时限内提交时放行，避免冻结画面

function start(direction: NavDirection, update: () => void | Promise<void>) {
  const doc = document as TransitionDocument;
  if (!doc.startViewTransition || interactionMotionReduced()) { void update(); return; }
  document.documentElement.dataset.navDirection = direction;
  const transition = doc.startViewTransition(update);
  void transition.finished.finally(() => { delete document.documentElement.dataset.navDirection; });
}

/** 同页状态变化（专注切换、计划应用后重排）用同一套过渡；不支持或减少动效时直接更新。 */
export function runViewTransition(update: () => void, direction: NavDirection = "swap") {
  start(direction, () => { flushSync(update); });
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
