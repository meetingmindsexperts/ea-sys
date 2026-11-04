import type { EventType } from "@prisma/client";
import { EVENT_TYPE_LABEL } from "@/lib/catalogue";

/**
 * What search engines and AI assistants read about the public side of the
 * site (Nov 4, 2026, owner: "this is a public page, need SEO and AEO"): the
 * site's address per host, schema.org structured data, the robots rules and
 * llms.txt. Pure, so every rule here is pinned by test; the routes and pages
 * run the queries.
 *
 * PER HOST. One image serves master and the platform instance, and each
 * organisation's site lives at its own address, so nothing here may hard-code
 * events.meetingmindsgroup.com: the origin comes from the request's host.
 */

const FALLBACK_ORIGIN =
  process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "https://events.meetingmindsgroup.com";

function protocolFor(host: string, forwardedProto?: string | null): "http" | "https" {
  if (forwardedProto === "http" || forwardedProto === "https") return forwardedProto;
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https";
}

/** This site's origin, from the request's host: https everywhere but a local machine. */
export function siteOrigin(host: string | null | undefined, forwardedProto?: string | null): string {
  const h = host?.trim().toLowerCase();
  if (!h || !/^[a-z0-9.-]+(:\d+)?$/.test(h)) return FALLBACK_ORIGIN.replace(/\/+$/, "");
  return `${protocolFor(h, forwardedProto)}://${h}`;
}

/** An absolute URL for a stored path such as /uploads/media/... */
export function absoluteUrl(origin: string, pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${origin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/**
 * A JSON-LD block's text, safe inside a <script> tag: `<` is escaped so an
 * event name containing "</script>" cannot close the tag early.
 */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export interface SeoEvent {
  slug: string;
  name: string;
  startDate: Date;
  endDate: Date;
  venue: string | null;
  city: string | null;
  country: string | null;
  eventType: EventType | null;
  specialty: string | null;
  bannerImage: string | null;
  bannerImageMobile?: string | null;
  cmeHours: { toString(): string } | null;
}

const ATTENDANCE_MODE: Record<EventType, string> = {
  CONFERENCE: "https://schema.org/OfflineEventAttendanceMode",
  WEBINAR: "https://schema.org/OnlineEventAttendanceMode",
  HYBRID: "https://schema.org/MixedEventAttendanceMode",
};

/** One sentence an assistant can quote: what, when-ish, where, and the CME hours. */
export function eventSummary(event: SeoEvent): string {
  const kind = event.eventType ? EVENT_TYPE_LABEL[event.eventType].toLowerCase() : "event";
  const online = event.eventType === "WEBINAR";
  // A webinar's city is the organiser's, not where it happens.
  const where = online ? "" : [event.city, event.country].filter(Boolean).join(", ");
  const parts = [
    `${event.name} is ${online ? "an online" : "a"} ${event.specialty ? `${event.specialty} ` : ""}${kind}${where ? ` in ${where}` : ""}`,
    event.cmeHours ? `carrying ${event.cmeHours.toString()} CME hours` : null,
  ].filter(Boolean);
  return `${parts.join(", ")}.`;
}

/** Both banners when there are two: Google prefers several aspect ratios. */
function eventImages(event: SeoEvent, origin: string): string[] {
  return [event.bannerImage, event.bannerImageMobile].filter((p): p is string => !!p).map((p) => absoluteUrl(origin, p));
}

/** schema.org Event for one event. Phase 2's event page adds offers and the full description. */
export function eventJsonLd(event: SeoEvent, origin: string, organizer: { name: string } | null) {
  const url = `${origin}/e/${event.slug}`;
  const online = event.eventType === "WEBINAR";
  const place = {
    "@type": "Place",
    ...(event.venue && { name: event.venue }),
    address: {
      "@type": "PostalAddress",
      ...(event.city && { addressLocality: event.city }),
      ...(event.country && { addressCountry: event.country }),
    },
  };
  return {
    "@type": "Event",
    name: event.name,
    url,
    startDate: event.startDate.toISOString(),
    endDate: event.endDate.toISOString(),
    eventStatus: "https://schema.org/EventScheduled",
    ...(event.eventType && { eventAttendanceMode: ATTENDANCE_MODE[event.eventType] }),
    location: online ? { "@type": "VirtualLocation", url } : place,
    description: eventSummary(event),
    ...(eventImages(event, origin).length > 0 && { image: eventImages(event, origin) }),
    ...(organizer && { organizer: { "@type": "Organization", name: organizer.name, url: origin } }),
  };
}

/** The catalogue's structured data: the organisation, the breadcrumb and the listed events. */
export function catalogueJsonLd(events: SeoEvent[], origin: string, organization: { name: string; logo: string | null } | null) {
  const org = organization && {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: organization.name,
    url: origin,
    ...(organization.logo && { logo: absoluteUrl(origin, organization.logo) }),
  };
  return {
    "@context": "https://schema.org",
    "@graph": [
      ...(org ? [org] : []),
      {
        "@type": "BreadcrumbList",
        itemListElement: [{ "@type": "ListItem", position: 1, name: "Event catalogue", item: `${origin}/catalogue` }],
      },
      {
        "@type": "ItemList",
        name: "Event catalogue",
        url: `${origin}/catalogue`,
        itemListElement: events.map((event, i) => ({
          "@type": "ListItem",
          position: i + 1,
          item: eventJsonLd(event, origin, organization),
        })),
      },
    ],
  };
}

/**
 * Paths no crawler should read: the dashboard, the API, sign-in, a person's
 * own pages, and every page reached by a secret link (shared views, survey,
 * RSVP and agreement links, completion and reset tokens). Robots rules are a
 * request, not access control: these pages are already behind auth or a
 * token, and this only keeps them out of indexes.
 *
 * /uploads/ is NOT here: banners and logos live there, and Google needs to
 * fetch an event's image for its event results (social cards honour robots
 * too). Private uploads are refused by the uploads route's own allow-list.
 */
export const ROBOTS_DISALLOW = [
  "/api/",
  "/dashboard",
  "/events",
  "/settings",
  "/contacts",
  "/crm",
  "/hr",
  "/procurement",
  "/invoices",
  "/media",
  "/activity",
  "/logs",
  "/admin",
  "/agent",
  "/profile",
  "/my-registration",
  "/my-reviews",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  "/verify-email",
  "/mcp-authorize",
  "/stream-clock",
  "/e/*/login",
  "/e/*/my-registration",
  "/e/*/my-group",
  "/e/*/confirmation",
  "/e/*/complete-registration",
  "/e/*/forgot-password",
  "/e/*/reset-password",
  "/e/*/shared/",
  "/e/*/floor-plan/",
  "/e/*/survey",
  "/e/*/rsvp",
  "/e/*/speaker-agreement",
  "/e/*/presenter-agreement",
  "/e/*/speaker-form",
  "/e/*/reimbursement",
  "/e/*/travel-grant",
  "/e/*/verify-details",
] as const;

export interface LlmsEvent extends SeoEvent {
  timezone: string;
}

/**
 * llms.txt (llmstxt.org): a plain-text map of the site for AI assistants.
 * Markdown, short, and factual: what the organisation runs, the events open
 * now, and how a person registers and gets their certificate.
 */
export function llmsText(input: {
  origin: string;
  /** Null when the site resolves no organisation (a local machine): the wording stays neutral. */
  organizationName: string | null;
  events: LlmsEvent[];
  formatDates: (event: LlmsEvent) => string;
}): string {
  const { origin, organizationName, events, formatDates } = input;
  const lines = [
    organizationName ? `# ${organizationName} events` : "# Medical events",
    "",
    `> Medical conferences, workshops and webinars${organizationName ? ` run by ${organizationName}` : ""}. Each event has a public page where healthcare professionals register; CME certificates are issued after the event and downloaded from My events.`,
    "",
    "## Find and register",
    "",
    `- [Event catalogue](${origin}/catalogue): every listed event, searchable by specialty, country and type`,
    `- Registering: open an event from the catalogue and choose Register. An account is created during registration.`,
    `- [My events](${origin}/my-registration): after signing in, a person's registrations, payment status and CME certificates`,
    "",
    "## Upcoming events",
    "",
  ];
  if (events.length === 0) lines.push("No upcoming events are listed right now.");
  for (const event of events) {
    const facts = [
      formatDates(event),
      [event.venue, event.city, event.country].filter(Boolean).join(", "),
      event.eventType && EVENT_TYPE_LABEL[event.eventType],
      event.specialty,
      event.cmeHours && `${event.cmeHours.toString()} CME hours`,
    ].filter(Boolean);
    lines.push(`- [${event.name}](${origin}/e/${event.slug}): ${facts.join(" · ")}`);
  }
  return `${lines.join("\n")}\n`;
}
