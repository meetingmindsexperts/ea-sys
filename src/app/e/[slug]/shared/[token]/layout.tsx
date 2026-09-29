import type { Metadata } from "next";
import { buildEventMetadata } from "@/lib/public-event-metadata";

/**
 * A shared submission view is reachable only by its secret link, so it must
 * never be indexed, and the token in the URL must never leave in a Referer
 * header when a viewer follows a link off the page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const base = await buildEventMetadata({ slug, section: "Submissions" });
  return {
    ...base,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
    openGraph: undefined,
    twitter: undefined,
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
