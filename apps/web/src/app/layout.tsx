import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppearancePreferencesProvider } from "../features/opening/settings/appearance-preferences";
import { appearanceBootstrap } from "../features/opening/settings/appearance-bootstrap";
import { ToastProvider } from "@aistudy/ui";
import "@blocknote/core/style.css";
import "./tailwind.css";

export const metadata: Metadata = {
  title: "AIstudy",
  description: "Lifelong learning platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: appearanceBootstrap }} /></head>
      <body className="min-h-screen bg-bg font-sans text-text"><AppearancePreferencesProvider><ToastProvider>{children}</ToastProvider></AppearancePreferencesProvider></body>
    </html>
  );
}
