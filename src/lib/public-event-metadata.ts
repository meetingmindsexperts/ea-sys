import type { Metadata } from "next";
import { cache } from "react";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * Shared builder for the per-event SEO metadata on the public `/e/[slug]/*`
 * pages. Each public sub-route (register, agenda, session, …) is a client
 * component and can't export `generateMetadata`, so a small server
 * `layout.tsx` per route calls this helper with its own `section` label —
 * giving titles like "Register — ACABC 2026", "Agenda — ACABC 2026", and the
 * actual session name on a session page.
 *
 * The event lookup is wrapped in React `cache()` so the parent `[slug]`
 * layout and the leaf section layout share a single query per request.
 */

const SITE_NAME = "Meeting Minds Events";
const MAX_DESCRIPTION = 160;

const getEventForMeta = cache(async (slug: string) =>
  db.event.findFirst({
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
  }),
);

const getSessionName = cache(async (slug: string, sessionId: string) => {
  const session = await db.eventSession.findFirst({
    where: { id: sessionId, event: { slug } },
    select: { name: true },
  });
  return session?.name ?? null;
});

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

export interface EventMetadataOptions {
  slug: string;
  /** Section label prefixed to the event name, e.g. "Register", "Agenda". */
  section?: string;
  /**
   * When set, the section label becomes the session's own name (falling back
   * to "Session"). Takes precedence over `section`.
   */
  sessionId?: string;
}

/**
 * Build per-event (+ optional per-section) Metadata. Returns `{}` (inherit the
 * generic platform metadata) when the event isn't found or the lookup fails,
 * so a metadata hiccup never breaks the page render.
 */
export async function buildEventMetadata({
  slug,
  section,
  sessionId,
}: EventMetadataOptions): Promise<Metadata> {
  try {
    const event = await getEventForMeta(slug);
    if (!event) return {};

    let sectionLabel = section;
    if (sessionId) {
      sectionLabel = (await getSessionName(slug, sessionId)) ?? "Session";
    }

    const title = sectionLabel ? `${sectionLabel} — ${event.name}` : event.name;

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
      title,
      description,
      openGraph: {
        title,
        description,
        siteName: SITE_NAME,
        type: "website",
        url: `/e/${slug}`,
        images: [{ url: ogImage, alt: event.name }],
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: [ogImage],
      },
    };
  } catch (err) {
    apiLogger.warn({ err, slug, section, sessionId, msg: "public-event:generate-metadata-failed" });
    return {};
  }
}
