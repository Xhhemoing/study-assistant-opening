"use client";

import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AssistantView, type AssistantViewProps } from "./assistant-view";
import { conversationObjectHref, validConversationId } from "./conversation-links";

type Mount = { token: symbol; order: number; owner: Session; target: HTMLDivElement; companion: boolean; props?: AssistantViewProps };
type Session = { key: string; conversationId: string | null; props: AssistantViewProps; container: HTMLDivElement; mounts: Mount[]; creating: boolean;
  awaitingPromotion: boolean; retained: { pending: boolean; volatile: boolean }; lastUsed: number;
  focused?: HTMLElement | null; scroll?: Array<{ element: HTMLElement; top: number; left: number }> };
type Host = {
  freshRevision: number;
  mount: (key: string, props: AssistantViewProps, target: HTMLDivElement, companion: boolean) => () => void;
  updateStart: (key: string, start: AssistantViewProps["start"]) => void;
};
const ConversationHost = createContext<Host | null>(null);

/** Ordinary chats live above routes; only their fixed portal container moves between visible slots. */
export function ConversationCompanionProvider({ children }: { children: ReactNode }) {
  const sessions = useRef(new Map<string, Session>());
  const parking = useRef<HTMLDivElement>(null);
  const mountOrder = useRef(0);
  const [, redraw] = useState(0);
  const [freshRevision, setFreshRevision] = useState(0);
  const render = useCallback(() => redraw(value => value + 1), []);
  const evictIdle = useCallback(() => {
    const idle = [...sessions.current.values()].filter(session => !session.mounts.length && !session.creating && !session.retained.pending && !session.retained.volatile)
      .sort((left, right) => right.lastUsed - left.lastUsed);
    for (const session of idle.slice(8)) { sessions.current.delete(session.key); session.container.remove(); }
  }, []);
  const find = useCallback((key: string, id?: string | null) => id ? [...sessions.current.values()].find(session => session.conversationId === id) : sessions.current.get(key), []);
  const position = useCallback((session: Session) => {
    const target = session.mounts.at(-1)?.target ?? parking.current;
    if (target && session.container.parentNode !== target) {
      const focused = document.activeElement instanceof HTMLElement && session.container.contains(document.activeElement) ? document.activeElement : null;
      if (focused) session.focused = focused;
      if (session.container.parentNode && session.container.parentNode !== parking.current) {
        session.scroll = [session.container, ...session.container.querySelectorAll<HTMLElement>("*")]
          .filter(element => element.scrollTop || element.scrollLeft).map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
      }
      target.appendChild(session.container);
      if (target !== parking.current && !target.closest("[hidden],[inert]")) {
        session.scroll?.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left; });
        const restore = focused ?? (document.activeElement === document.body ? session.focused : null);
        if (restore?.isConnected) restore.focus({ preventScroll: true });
      }
    }
  }, []);
  const mount = useCallback<Host["mount"]>((key, props, target, companion) => {
    let session = find(key, props.initialConversationId);
    if (!session) {
      const container = document.createElement("div");
      container.className = "h-full min-h-0 w-full";
      session = { key, props, container, conversationId: props.initialConversationId ?? null, mounts: [], creating: false,
        awaitingPromotion: Boolean(props.initialConversationId && [...sessions.current.values()].some(other => other.creating)),
        retained: { pending: true, volatile: true }, lastUsed: mountOrder.current + 1 };
      sessions.current.set(key, session);
    }
    const token = Symbol("conversation-mount");
    const entry = { token, order: ++mountOrder.current, owner: session, target, companion, props };
    session.lastUsed = entry.order;
    session.mounts.push(entry);
    position(session); render();
    return () => { const owned = entry.owner; owned.mounts = owned.mounts.filter(mount => mount.token !== token); position(owned); evictIdle(); render(); };
  }, [find, position, render, evictIdle]);
  const updateStart = useCallback<Host["updateStart"]>((key, start) => {
    const session = sessions.current.get(key);
    if (session && session.props.start !== start) { session.props = { ...session.props, start }; render(); }
  }, [render]);
  const host = useMemo(() => ({ freshRevision, mount, updateStart }), [freshRevision, mount, updateStart]);
  return <ConversationHost.Provider value={host}>
    {children}
    <div ref={parking} hidden inert aria-hidden="true" data-conversation-parking="true" />
    {[...sessions.current.values()].map(session => {
      const active = session.mounts.at(-1);
      const blocked = session.awaitingPromotion && [...sessions.current.values()].some(other => other !== session && other.creating);
      return createPortal(<div className="flex h-full min-h-0 w-full flex-col">
        {blocked ? <p role="status" className="shrink-0 px-4 py-2 text-xs text-text-2">正在确认新对话的保存结果，确认后即可继续输入。</p> : null}
        <div className="min-h-0 flex-1"><AssistantView {...session.props} companion={active?.companion ?? false}
        interactionDisabled={blocked}
        isActiveConversation={() => session.mounts.length > 0}
        objectHref={href => conversationObjectHref(href, session.conversationId)}
        // A saved identity must leave its fixed slot through the explicit fresh route.
        // Unsaved starts can fork locally while their first creation remains parked.
        onStartNew={session.conversationId ? undefined : () => setFreshRevision(value => value + 1)}
        onRetainStateChange={state => {
          if (session.retained.pending === state.pending && session.retained.volatile === state.volatile) return;
          session.retained = state; evictIdle(); render();
        }}
        onConversationCreateStateChange={creating => {
          session.creating = creating;
          if (!creating && ![...sessions.current.values()].some(other => other.creating)) sessions.current.forEach(other => { other.awaitingPromotion = false; });
          evictIdle(); render();
        }}
        onConversationReady={id => {
          const collision = [...sessions.current.values()].find(other => other !== session && other.conversationId === id);
          if (collision) {
            // Its editor was blocked while the new identity was unresolved. Preserve the
            // original in-flight chat, and transfer only the authorized view's display slots.
            collision.mounts.forEach(mount => { mount.owner = session; });
            session.mounts = [...session.mounts, ...collision.mounts].sort((left, right) => left.order - right.order);
            collision.mounts = [];
            sessions.current.delete(collision.key);
            collision.container.remove();
            position(session);
          }
          session.conversationId = id; render();
          // A late creation may finish in the parked chat after a different route opened.
          const visible = session.mounts.at(-1);
          if (visible && !visible.companion) visible.props?.onConversationReady?.(id);
        }} /></div></div>, session.container, session.key);
    })}
  </ConversationHost.Provider>;
}

/** Only ordinary chat is hosted. Canonical task/attempt sessions retain their own strict binding. */
export function ConversationSurface(props: AssistantViewProps) {
  const host = useContext(ConversationHost);
  if (!host || props.learningAttempt || props.studyContext || props.studyContextError) return <AssistantView {...props} />;
  return <HostedConversationSurface host={host} view={props} />;
}
function HostedConversationSurface({ host, view }: { host: Host; view: AssistantViewProps }) {
  const target = useRef<HTMLDivElement>(null);
  const instance = useId();
  const key = view.initialConversationId ? `conversation:${view.initialConversationId}` : `start:${instance}:${host.freshRevision}`;
  const initial = useRef(view);
  initial.current = view;
  useLayoutEffect(() => target.current ? host.mount(key, initial.current, target.current, false) : undefined, [host.mount, key]);
  useLayoutEffect(() => host.updateStart(key, view.start), [host.updateStart, key, view.start]);
  return <div ref={target} className="h-full min-h-0 w-full" data-conversation-surface="true" />;
}

/** No implicit recent-chat fallback. Unknown ids are restored through the normal authorized server APIs. */
export function OriginalConversationSlot({ conversationId, className = "" }: { conversationId?: string | null; className?: string }) {
  const host = useContext(ConversationHost);
  if (!conversationId) return null;
  if (!validConversationId(conversationId)) return <p role="alert" className="text-xs text-danger">原对话链接无效，请从对话历史重新打开。</p>;
  if (!host) return <div className={className}><AssistantView initialConversationId={conversationId} companion /></div>;
  return <HostedOriginalConversation host={host} conversationId={conversationId} className={className} />;
}
function HostedOriginalConversation({ host, conversationId, className }: { host: Host; conversationId: string; className: string }) {
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => target.current ? host.mount(`conversation:${conversationId}`, { initialConversationId: conversationId }, target.current, true) : undefined, [host.mount, conversationId]);
  return <div ref={target} className={`h-full min-h-0 w-full ${className}`} data-original-conversation={conversationId} />;
}
