import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Absolute base so relative OG/Twitter image paths (e.g. an event's
// /uploads/... banner) resolve to fully-qualified URLs for crawlers.
const appUrl =
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "https://events.meetingmindsgroup.com";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "Meeting Minds Events Management Platform",
  description: "Event management platform by Meeting Minds Group — conferences, meetings, and events",
  icons: {
    icon: "/mmg-logo.png",
    shortcut: "/mmg-logo.png",
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
