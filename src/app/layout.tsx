import type { Metadata } from "next";
import { geistMono, geistSans } from "./fonts";
import { Providers } from "@/components/providers";
import "./globals.css";

// Absolute base so relative OG/Twitter image paths (e.g. an event's
// /uploads/... banner) resolve to fully-qualified URLs for crawlers.
const appUrl =
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "https://events.meetingmindsgroup.com";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "Meeting Minds Events Management Platform",
  description: "Event management platform by Meeting Minds Group for conferences, meetings, and events",
  icons: {
    // The logo is black on transparent, so a dark browser theme gets the white copy. Square and
    // trimmed of its margin, or a tab shrinks the wide logo to about 60% of its height.
    icon: [
      { url: "/mmg-icon.png", media: "(prefers-color-scheme: light)" },
      { url: "/mmg-icon-light.png", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/mmg-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
