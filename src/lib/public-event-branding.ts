/**
 * The branding a public event page shows around a message when it has nothing
 * else to show: the banner, the event's name, dates and place, and the footer
 * (Nov 17, 2026).
 *
 * Before this, a page that could not show its content (the agenda not yet
 * published, a closed form, a link that no longer works) dropped the whole
 * event frame and rendered a bare card on a blank screen, because each page
 * got its branding from the same request that had just failed. The public
 * `[slug]` layout now reads it once on the server and hands it to every page
 * below it (`PublicEventBrandingProvider`), so a page needs no second request
 * to stay branded.
 *
 * Client-safe: no database import. The server read is `getPublicEventShell`.
 */
import type { EventStatus } from "@prisma/client";

export interface PublicEventBranding {
  name: string;
  /** ISO strings: this crosses the server/client boundary. */
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  bannerImage?: string | null;
  bannerImageMobile?: string | null;
  footerHtml?: string | null;
  supportEmail?: string | null;
}

/**
 * The statuses whose branding may be shown to anyone. The same three the
 * public event page (`/e/{slug}`) serves. A DRAFT event's name and banner are
 * not public yet, and a CANCELLED one's are withdrawn, so both get the plain
 * frame.
 */
export const BRANDED_EVENT_STATUSES: readonly EventStatus[] = ["PUBLISHED", "LIVE", "COMPLETED"];

export interface PublicEventBrandingRow {
  status: EventStatus;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  timezone: string | null;
  venue: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  bannerImageMobile: string | null;
  footerHtml: string | null;
  supportEmail: string | null;
}

/** Null when there is no event, or its branding is not public. */
export function toPublicEventBranding(event: PublicEventBrandingRow | null | undefined): PublicEventBranding | null {
  if (!event) return null;
  if (!BRANDED_EVENT_STATUSES.includes(event.status)) return null;
  return {
    name: event.name,
    startDate: event.startDate ? event.startDate.toISOString() : null,
    endDate: event.endDate ? event.endDate.toISOString() : null,
    timezone: event.timezone,
    venue: event.venue,
    city: event.city,
    country: event.country,
    bannerImage: event.bannerImage,
    bannerImageMobile: event.bannerImageMobile,
    footerHtml: event.footerHtml,
    supportEmail: event.supportEmail,
  };
}
