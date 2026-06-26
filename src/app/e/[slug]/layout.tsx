import type { Metadata } from "next";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Per-event SEO metadata for every public `/e/[slug]/*` page.
 *
 * The public pages (register, agenda, session, confirmation, …) are all
 * client components and therefore can't export `generateMetadata`. This
 * server layout owns the metadata for the whole subtree, so a shared
 * registration link (e.g. /e/acabc2026/register) surfaces the event's own
 * name, description, and banner image when pasted into WhatsApp / LinkedIn /
 * search results — instead of the generic platform title.
 *
 * Falls back to generic metadata if the event isn't found or the lookup
 * fails, so a metadata hiccup never breaks the page render.
 */

const SITE_NAME = "Meeting Minds Events";
const MAX_DESCRIPTION = 160;

/** Strip HTML tags + decode the few common entities, collapse whitespace. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const event = await db.event.findFirst({
      where: { slug },
      select: {
        name: true,
        description: true,
        bannerImage: true,
        venue: true,
        city: true,
        country: true,
        startDate: true,
      },
    });

    if (!event) return {};

    // Description: event's own (HTML-stripped) text, else a composed fallback.
    const dateStr = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "";
    const location = [event.venue, event.city, event.country]
      .filter(Boolean)
      .join(", ");
    const composedFallback = `Register for ${event.name}${dateStr ? `, ${dateStr}` : ""}${location ? ` · ${location}` : ""}.`;
    const rawDescription = event.description?.trim()
      ? toPlainText(event.description)
      : composedFallback;
    const description = truncate(rawDescription, MAX_DESCRIPTION);

    // Banner is the share image when present (relative path resolves via the
    // root layout's metadataBase); otherwise fall back to the platform logo.
    const ogImage = event.bannerImage || "/mmg-logo.png";

    return {
      title: event.name,
      description,
      openGraph: {
        title: event.name,
        description,
        siteName: SITE_NAME,
        type: "website",
        url: `/e/${slug}`,
        images: [{ url: ogImage, alt: event.name }],
      },
      twitter: {
        card: "summary_large_image",
        title: event.name,
        description,
        images: [ogImage],
      },
    };
  } catch (err) {
    apiLogger.warn({ err, slug, msg: "public-event:generate-metadata-failed" });
    return {};
  }
}

export default function PublicEventLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
