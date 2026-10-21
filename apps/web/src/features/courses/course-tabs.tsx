"use client";

import { Children, cloneElement, isValidElement, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { courseTabHref, courseTabs, readCourseTab, type CourseTab } from "./course-tabs-route";

type PanelProps = { name: CourseTab; hidden?: boolean; children: ReactNode };

export function CoursePanel({ name, hidden, children }: PanelProps) {
  return <section hidden={hidden} aria-label={courseTabs.find(tab => tab.id === name)?.label} className="space-y-6">{children}</section>;
}

/** Link navigation preserves mounted forms and recognizes bookmarked legacy sections. */
export function CourseTabs({ courseId, children }: { courseId: string; children: ReactNode }) {
  const [location, setLocation] = useState({ tab: "overview" as CourseTab, search: "", hash: "" });
  useEffect(() => {
    const sync = () => setLocation({ tab: readCourseTab(window.location.search, window.location.hash), search: window.location.search, hash: window.location.hash });
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("hashchange", sync); };
  }, [courseId]);
  useEffect(() => {
    if (!location.hash) return;
    const target = document.getElementById(location.hash.slice(1));
    let node: HTMLElement | null = target;
    while (node) { if (node instanceof HTMLDetailsElement) node.open = true; node = node.parentElement; }
    target?.scrollIntoView({ block: "start" });
  }, [location]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, tab: CourseTab) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const href = courseTabHref(courseId, tab, window.location.search);
    window.history.pushState(null, "", href);
    setLocation({ tab, search: window.location.search, hash: "" });
  }

  return <>
    <nav aria-label="课程分区" className="flex gap-1 border-b border-line">
      {courseTabs.map(tab => <a key={tab.id} href={courseTabHref(courseId, tab.id, location.search)} onClick={event => navigate(event, tab.id)} aria-current={location.tab === tab.id ? "page" : undefined} className={`min-h-11 flex-1 border-b-2 px-3 py-3 text-center text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${location.tab === tab.id ? "border-ink text-accent" : "border-transparent text-text-2 hover:text-text"}`}>{tab.label}</a>)}
    </nav>
    {Children.map(children, child => isValidElement<PanelProps>(child) ? cloneElement(child, { hidden: child.props.name !== location.tab }) : child)}
  </>;
}
