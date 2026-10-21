"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export function ConnectionNotice() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return offline ? <p role="status" className="flex items-center gap-2 border-b border-warn/30 bg-warn-soft px-5 py-2 text-xs leading-5 text-warn"><WifiOff size={16} aria-hidden="true" />当前离线，已输入的内容仍在本页。恢复连接后请重试未完成的操作。</p> : null;
}
