import type { Metadata } from "next";
import { buildEventMetadata } from "@/lib/public-event-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildEventMetadata({ slug, section: "Speaker Agreement" });
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
