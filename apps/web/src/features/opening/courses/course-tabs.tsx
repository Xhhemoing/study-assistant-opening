"use client";

import { ChevronDown } from "lucide-react";
import { Children, cloneElement, isValidElement, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { courseSection, courseSections, courseTabHref, courseTabs, readCourseTab, type CourseTab } from "./course-tabs-route";

type PanelProps = { name: CourseTab; hidden?: boolean; secondary?: boolean; children: ReactNode };

export function CoursePanel({ name, hidden, secondary, children }: PanelProps) {
  const label = courseTabs.find(tab => tab.id === name)?.label;
  return <section hidden={hidden} aria-label={label} data-course-tab={name} className="space-y-6">{secondary ? <details className="group space-y-4 rounded-card border border-line bg-surface px-4 py-3 shadow-card"><summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-1 text-sm font-medium text-text [&::-webkit-details-marker]:hidden"><span>{label}</span><ChevronDown size={15} aria-hidden="true" className="shrink-0 text-text-3 transition-transform duration-200 ease-out-strong group-open:rotate-180" /></summary>{children}</details> : children}</section>;
}

/** Link navigation preserves mounted forms and recognizes bookmarked legacy sections. */
export function CourseTabs({ courseId, children, conversationId, grouped = false }: { courseId: string; children: ReactNode; conversationId?: string; grouped?: boolean }) {
  const routeSearch = useSearchParams()?.toString();
  const [location, setLocation] = useState({ tab: "overview" as CourseTab, search: conversationId ? `?${new URLSearchParams({ conversation: conversationId })}` : "", hash: "" });
  useEffect(() => {
    const sync = () => setLocation({ tab: readCourseTab(window.location.search, window.location.hash), search: window.location.search, hash: window.location.hash });
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("hashchange", sync); };
  }, [courseId, routeSearch]);
  useEffect(() => {
    const panel = document.querySelector<HTMLElement>(`[data-course-tab="${location.tab}"]`);
    if (grouped && (location.tab === "practice" || location.tab === "review")) {
      const details = panel?.querySelector("details");
      if (details) details.open = true;
    }
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : panel;
    let node: HTMLElement | null = target;
    while (node) { if (node instanceof HTMLDetailsElement) node.open = true; node = node.parentElement; }
    if (location.hash || (grouped && location.tab !== courseSection(location.tab))) target?.scrollIntoView({ block: "start" });
  }, [location, grouped]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, tab: CourseTab) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const href = courseTabHref(courseId, tab, window.location.search);
    window.history.pushState(null, "", href);
    setLocation({ tab, search: window.location.search, hash: "" });
  }

  const tabs = grouped ? courseSections : courseTabs.filter(tab => tab.id !== "units");
  const active = grouped ? courseSection(location.tab) : location.tab === "units" ? "overview" : location.tab;
  return <>
    <nav aria-label="课程分区" className="well-recessed no-scrollbar flex items-center gap-1 overflow-x-auto rounded-xl p-1">
      {tabs.map(tab => <a key={tab.id} href={courseTabHref(courseId, tab.id, location.search)} onClick={event => navigate(event, tab.id)} aria-current={active === tab.id ? "page" : undefined} className={`min-h-9 shrink-0 flex-1 whitespace-nowrap rounded-lg px-3.5 py-2 text-center text-sm font-medium transition-[background-color,color,box-shadow] duration-150 ease-out-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active === tab.id ? "bg-surface text-text shadow-card" : "text-text-2 hover:text-text"}`}>{tab.label}</a>)}
    </nav>
    {Children.map(children, child => isValidElement<PanelProps>(child) ? cloneElement(child, { hidden: grouped ? courseSection(child.props.name) !== active : child.props.name !== location.tab }) : child)}
  </>;
}
