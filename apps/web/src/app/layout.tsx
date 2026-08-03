import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./tailwind.css";

export const metadata: Metadata = {
  title: "AIstudy",
  description: "Lifelong learning platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
      >
        {children}
      </body>
    </html>
  );
}
