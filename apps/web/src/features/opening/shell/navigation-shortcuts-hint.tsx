"use client";

import { useEffect, useState } from "react";
const key = "aistudy:navigation-shortcuts-seen";

export function NavigationShortcutsHint() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try { setVisible(window.localStorage.getItem(key) !== "1"); }
    catch { setVisible(true); }
  }, []);
  if (!visible) return null;
  return <div className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-4 py-2 text-xs leading-6 text-text-2" role="note">
    <p>Ctrl / ⌘ K 搜索，Ctrl / ⌘ J 打开助理。</p>
    <button type="button" className="min-h-11 shrink-0 rounded-md px-2 text-accent focus-visible:ring-2 focus-visible:ring-accent" onClick={() => {
      setVisible(false);
      try { window.localStorage.setItem(key, "1"); } catch { /* Dismissal still applies to this mounted shell. */ }
    }}>知道了</button>
  </div>;
}
