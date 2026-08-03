"use client";

import { AppShell, getWorkspaceEntry } from "@aistudy/ui";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../search/command-palette";

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const activeEntry = getWorkspaceEntry(pathname.split("/")[1]);
  const [userLabel, setUserLabel] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { user: { displayName: string } };
        setUserLabel(body.user.displayName);
      })
      .catch(() => undefined);
  }, []);

  async function logout() {
    setLogoutPending(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        setLogoutError("退出失败，请重试。");
        return;
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError("网络连接异常，请重试退出。");
    } finally {
      setLogoutPending(false);
    }
  }

  return (
    <>
      <AppShell
        activeEntry={activeEntry}
        logoutPending={logoutPending}
        onLogout={logout}
        onOpenCommandPalette={openPalette}
        userLabel={userLabel}
      >
        {logoutError ? <div className="app-shell__logout-error" role="alert">{logoutError}</div> : null}
        {children}
      </AppShell>
      <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
    </>
  );
}
