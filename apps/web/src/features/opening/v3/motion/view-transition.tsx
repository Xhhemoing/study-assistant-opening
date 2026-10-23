"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, type ComponentProps, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { interactionMotionReduced } from "../../design/haptics";
import { navDirection } from "../shell/features";

export type NavDirection = "forward" | "back" | "swap" | "local";

type ViewTransitionHandle = { finished: Promise<void>; skipTransition: () => void };
type TransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => ViewTransitionHandle };

let pending: (() => void) | null = null;
/** 已挂载的过渡边界数量：没有边界（壳层外页面、单元测试）时链接退回普通跳转，避免画面冻结等待 */
let boundaries = 0;
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
  const page = direction !== "local";
  if (page) markPageTitle();
  const transition = doc.startViewTransition(page ? () => Promise.resolve(update()).then(() => {
    // 新画面：来源行已不在（或仍在但不再参与），只让新页面的第一个标题承接
    document.querySelectorAll("[data-vt-source]").forEach(node => node.removeAttribute("data-vt-source"));
    markPageTitle();
  }) : update);
  active = transition;
  void transition.finished.finally(() => {
    if (active === transition) {
      active = null; delete document.documentElement.dataset.navDirection;
      document.querySelectorAll("[data-vt-title-active],[data-vt-source]").forEach(node => { node.removeAttribute("data-vt-title-active"); node.removeAttribute("data-vt-source"); });
    }
    onDone?.();
  });
}

/**
 * 页面标题共享过渡：同一时刻只能有一个元素叫 page-title（重名会让整次过渡失效），
 * 所以只给主区第一个页面标题打标记；点击了带 vtSource 的来源行时，旧画面由来源行承担这个名字。
 */
function markPageTitle() {
  document.querySelectorAll("[data-vt-title-active]").forEach(node => node.removeAttribute("data-vt-title-active"));
  if (document.querySelector("[data-vt-source]")) return;
  document.querySelector("main [data-page-title]")?.setAttribute("data-vt-title-active", "");
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
export function useTransitionRouter(): TransitionRouter;
export function useTransitionRouter(available: boolean): TransitionRouter | null;
export function useTransitionRouter(available = true): TransitionRouter | null {
  const router = useOptionalRouter();
  const pathname = useOptionalPathname();
  const go = useCallback((href: string, mode: "push" | "replace" = "push", direction?: NavDirection) => {
    const target = href.split("?")[0] ?? href;
    const dir = direction ?? navDirection(pathname, target);
    start(dir, () => new Promise<void>(resolve => {
      const timer = window.setTimeout(() => { pending = null; resolve(); }, SETTLE_TIMEOUT_MS);
      pending = () => { window.clearTimeout(timer); pending = null; resolve(); };
      if (mode === "replace") router?.replace(href); else router?.push(href);
    }));
  }, [router, pathname]);
  if (!router || !available) return null as unknown as TransitionRouter;
  return { push: (href: string, direction?: NavDirection) => go(href, "push", direction), replace: (href: string) => go(href, "replace", "swap"), back: () => router?.back() };
}

type TransitionRouter = { push: (href: string, direction?: NavDirection) => void; replace: (href: string) => void; back: () => void };
const isExternal = (href: string) => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) || href.startsWith("#");

/** 放在壳层内：路径或查询变化提交到 DOM 后放行等待中的过渡。 */
export function ViewTransitionBoundary() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString();
  useLayoutEffect(() => { pending?.(); }, [pathname, search]);
  useEffect(() => {
    boundaries += 1;
    // 浏览器后退 / 前进：Next 在 popstate 后异步提交新路由，这里用「返回」方向包住这次提交。
    const onPop = () => {
      start("back", () => new Promise<void>(resolve => {
        const timer = window.setTimeout(() => { pending = null; resolve(); }, SETTLE_TIMEOUT_MS);
        pending = () => { window.clearTimeout(timer); pending = null; resolve(); };
      }));
    };
    window.addEventListener("popstate", onPop);
    return () => { boundaries -= 1; window.removeEventListener("popstate", onPop); };
  }, []);
  return null;
}

/** 测试与壳层外渲染没有 App Router：返回 null，让链接退回普通 next/link 行为。 */
function useOptionalRouter() {
  try { return useRouter(); } catch { return null; }
}
/** 单元测试常只模拟部分 next/navigation：缺少 usePathname 时按空路径处理 */
function useOptionalPathname() {
  try { return usePathname() ?? ""; } catch { return ""; }
}

type TransitionLinkProps = ComponentProps<typeof Link> & { href: string; direction?: NavDirection; vtSource?: "object-title" };

/**
 * 站内链接统一用它：普通左键点击走带过渡的跳转；修饰键、新窗口、外链保持浏览器默认。
 * vtSource：点击时给来源元素内的 [data-vt-title] 打上共享元素标记，目标页标题平滑承接。
 */
export function TransitionLink({ href, direction, vtSource, onClick, replace, ...rest }: TransitionLinkProps) {
  const available = useOptionalRouter() !== null;
  const router = useTransitionRouter(available);
  function handle(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (!router || boundaries === 0 || isExternal(href) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target === "_blank") return;
    event.preventDefault();
    if (vtSource) {
      document.querySelectorAll("[data-vt-source]").forEach(node => node.removeAttribute("data-vt-source"));
      (event.currentTarget.querySelector("[data-vt-title]") ?? event.currentTarget).setAttribute("data-vt-source", vtSource);
    }
    if (replace) router.replace(href); else router.push(href, direction);
  }
  return <Link href={href} replace={replace} onClick={handle} {...rest} />;
}
