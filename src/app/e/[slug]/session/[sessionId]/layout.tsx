import type { Metadata } from "next";
import { buildEventMetadata } from "@/lib/public-event-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; sessionId: string }>;
}): Promise<Metadata> {
  const { slug, sessionId } = await params;
  return buildEventMetadata({ slug, sessionId });
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
