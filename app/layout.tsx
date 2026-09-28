import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "one-chat | 오늘만의 대화",
  description: "초대 링크와 닉네임으로 시작하는 9시간 대화방.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
