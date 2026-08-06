import type { Metadata } from "next";
import { cache } from "react";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveTenantOrg, normalizeHost } from "@/lib/tenant/resolver";
import { apiLogger } from "@/lib/logger";
import { publicEventWhereForHost } from "@/lib/public-event";

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

// `host` participates in the React cache() key so two layouts on the same
// request (same host) still share one query, while the lookup stays
// tenant-scoped (generateMetadata has no Request object — the host comes from
// next/headers in buildEventMetadata below).
const getEventForMeta = cache(async (host: string | null, slug: string) =>
  db.event.findFirst({
    where: await publicEventWhereForHost(host, slug),
    select: {
      name: true,
      description: true,
      bannerImage: true,
      venue: true,
      city: true,
      country: true,
      startDate: true,
      // Brand colour for the public theme. Selected HERE rather than in a
      // second query so the `[slug]` layout's metadata + theming share the
      // one cached lookup per request.
      organization: { select: { primaryColor: true } },
    },
  }),
);

/**
 * The organisation's brand colour for a public event page, or null.
 *
 * Shares `getEventForMeta`'s React `cache()` entry, so calling this from the
 * public layout costs no extra query on a request that already built metadata.
 */
export async function getPublicEventBrandColor(slug: string): Promise<string | null> {
  try {
    const host = (await headers()).get("host");
    const event = await getEventForMeta(host, slug);
    return event?.organization?.primaryColor ?? null;
  } catch (err) {
    // Theming must never break a public page — an unbranded page is fine.
    apiLogger.warn({ err, msg: "public-event-theme:brand-color-lookup-failed", slug });
    return null;
  }
}

const getSessionName = cache(async (host: string | null, slug: string, sessionId: string) => {
  // tenancy: EventSession is swept (Sessions sweep, Domain #12) — resolve the
  // tenant org from the host and ride the store, else the read fail-closes to
  // null on the platform (session social/OG title goes missing). Passthrough on
  // master; publicEventWhereForHost still enforces the event/tenant match.
  const tenant = await resolveTenantOrg(normalizeHost(host));
  const where = await publicEventWhereForHost(host, slug);
  const session = await runWithTenant(tenant.orgId ?? "", () =>
    db.eventSession.findFirst({
      where: { id: sessionId, event: where },
      select: { name: true },
    }),
  );
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
    const host = (await headers()).get("host");
    const event = await getEventForMeta(host, slug);
    if (!event) return {};

    let sectionLabel = section;
    if (sessionId) {
      sectionLabel = (await getSessionName(host, slug, sessionId)) ?? "Session";
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
