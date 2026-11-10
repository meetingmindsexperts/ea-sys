import { headers } from "next/headers";
import { loadPublicBrandForHost } from "@/lib/public-brand-server";
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

// The tab title is the attendee-facing brand (public-brand.ts). The dashboard
// layout names the organisation instead for staff.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await loadPublicBrandForHost((await headers()).get("host"));
  return { ...metadata, title: brand.name, description: `${brand.name}: registrations, abstracts and certificates for conferences, meetings and webinars` };
}

const metadata: Metadata = {
  metadataBase: new URL(appUrl),
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
