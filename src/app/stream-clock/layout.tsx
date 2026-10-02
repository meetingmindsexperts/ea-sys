import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Stream clock",
  robots: { index: false, follow: false },
};

export default function StreamClockLayout({ children }: { children: React.ReactNode }) {
  return children;
}
