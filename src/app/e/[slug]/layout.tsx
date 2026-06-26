import type { Metadata } from "next";
import { buildEventMetadata } from "@/lib/public-event-metadata";

/**
 * Base per-event SEO metadata for the public `/e/[slug]` subtree. Each public
 * sub-route (register, agenda, session, …) has its own `layout.tsx` that
 * overrides this with a section-specific title; this base covers the bare
 * `/e/[slug]` entry and anything without its own section layout.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildEventMetadata({ slug });
}

export default function PublicEventLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
