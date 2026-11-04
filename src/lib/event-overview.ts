import type { EventType } from "@prisma/client";
import type { AccreditationEntry } from "@/lib/certificates/types";
import { friendlyAccreditorName } from "@/lib/certificates/template";
import { formatCurrency } from "@/lib/utils";
import { mainLinkTiers, mainRegisterTarget, tierAvailability } from "@/lib/public-availability";
import { registerTierSlug } from "@/lib/main-register-tiers";
import { readCodeRequiredTiers } from "@/lib/code-required-tiers";
import { eventJsonLd, type SeoEvent } from "@/lib/seo";

/**
 * The public event page at /e/{slug} (Nov 4, 2026, catalogue phase 2): the
 * facts it shows, the questions it answers and the structured data it
 * carries. Pure, so every rule is pinned by test; the page runs the queries.
 *
 * WHY A PAGE AND NOT THE FORM. /e/{slug} used to redirect straight into the
 * registration form, a client page whose HTML carried six words. Search
 * engines and AI assistants read HTML, so an event was invisible to them
 * beyond its title. This page puts everything a person (or an assistant
 * answering for one) needs in the HTML, and the form stays one tap away.
 */

/** A registration type as the event page loads it: its rates with their windows and seats. */
export interface PublicTicketType {
  quantity: number;
  soldCount: number;
  pricingTiers: {
    name: string;
    sortOrder: number | null;
    price: { toString(): string };
    currency: string;
    quantity: number;
    soldCount: number;
    salesStart: Date | null;
    salesEnd: Date | null;
  }[];
}

export interface PublicOffer {
  /** Lowest paid price at the rate the Register link lands on, in its currency. */
  price: number;
  currency: string;
  /** Something can be bought right now. */
  onSale: boolean;
  /** Every place is taken. */
  soldOut: boolean;
}

export type RegistrationState = "open" | "closed" | "sold-out" | "ended";

/**
 * Whether a visitor can register and from what price, answered by the SAME
 * rules the public API and the register page use (public-availability.ts):
 * "open" exactly when the main Register link has a rate to land on, and the
 * price is that rate's lowest paid price across the registration types,
 * which is what the visitor sees on the form. A free rate (exhibitor, a
 * sponsored delegate) never makes a paid event read Free; Free only when
 * every price at the rate is 0.
 */
export function publicRegistration(
  input: {
    endDate: Date;
    registrationOpen: boolean;
    eventFull: boolean;
    eventType: string | null;
    settings: unknown;
    ticketTypes: PublicTicketType[];
  },
  now: Date,
): { state: RegistrationState; offer: PublicOffer | null } {
  if (input.endDate < now) return { state: "ended", offer: null };
  const types = input.ticketTypes.map((t) => ({
    pricingTiers: t.pricingTiers.map((tier) => ({ ...tier, ...tierAvailability(tier, t, now) })),
  }));
  const codeRequiredTiers = readCodeRequiredTiers(input.settings);
  const mainRegisterTiers = (input.settings as { mainRegisterTiers?: unknown } | null)?.mainRegisterTiers;
  const target = mainRegisterTarget({
    registrationOpen: input.registrationOpen,
    eventFull: input.eventFull,
    eventType: input.eventType,
    ticketTypes: types,
    mainRegisterTiers,
    codeRequiredTiers,
  });
  const allTiers = types.flatMap((t) => t.pricingTiers);
  // A HYBRID event at its in-person cap is still open for virtual attendance,
  // which has its own price (virtualPrice): no in-person price is quoted.
  if (target && input.eventFull && input.eventType === "HYBRID") return { state: "open", offer: null };
  if (target) {
    const slug = registerTierSlug(target.name);
    return { state: "open", offer: cheapest(allTiers.filter((t) => t.canPurchase && registerTierSlug(t.name) === slug), true, false) };
  }
  // Full, rather than closed: the event cap is reached, or every ticked public
  // rate whose window is open has no seats left.
  const ticked = mainLinkTiers(mainRegisterTiers, codeRequiredTiers);
  const inWindow = allTiers.filter((t) => ticked.includes(registerTierSlug(t.name)) && t.salesStarted && !t.salesEnded);
  const full = (input.eventFull && input.eventType !== "HYBRID") || (inWindow.length > 0 && inWindow.every((t) => t.soldOut));
  if (input.registrationOpen && full) return { state: "sold-out", offer: cheapest(inWindow, false, true) };
  return { state: "closed", offer: null };
}

function cheapest(tiers: { price: { toString(): string }; currency: string }[], onSale: boolean, soldOut: boolean): PublicOffer | null {
  const priced = tiers.map((t) => ({ price: Number(t.price.toString()), currency: t.currency }));
  const paid = priced.filter((p) => p.price > 0);
  const pool = paid.length > 0 ? paid : priced;
  if (pool.length === 0) return null;
  const best = pool.reduce((a, b) => (b.price < a.price ? b : a));
  return { ...best, onSale, soldOut };
}

export function offerLabel(offer: PublicOffer): string {
  return offer.price === 0 ? "Free" : `From ${formatCurrency(offer.price, offer.currency)}`;
}

/** An accreditor as a person would read it; an unnamed OTHER is left out rather than shown as "The Accrediting Body". */
export function accreditorLabel(entry: Pick<AccreditationEntry, "body" | "name">): string | null {
  const named = entry.name?.trim();
  if (named) return named;
  return entry.body === "OTHER" ? null : friendlyAccreditorName(entry.body);
}

export function readAccreditations(settings: unknown): AccreditationEntry[] {
  const cme = (settings as { cme?: { accreditations?: unknown } } | null)?.cme;
  if (!Array.isArray(cme?.accreditations)) return [];
  return cme.accreditations.filter(
    (a): a is AccreditationEntry => !!a && typeof a === "object" && typeof (a as { body?: unknown }).body === "string",
  );
}

export interface OverviewFacts {
  event: SeoEvent & { timezone: string };
  dates: string;
  accreditors: string[];
  audiences: string[];
  offer: PublicOffer | null;
  state: RegistrationState;
  origin: string;
}

const KIND: Record<EventType, string> = { CONFERENCE: "conference", WEBINAR: "webinar", HYBRID: "hybrid event" };

function where(event: SeoEvent): string {
  if (event.eventType === "WEBINAR") return "online";
  const place = [event.venue, event.city, event.country].filter(Boolean).join(", ");
  return place ? `at ${place}` : "";
}

/**
 * The questions the page answers, written from the event's own data and
 * nothing else: a question is asked only when the event can answer it. AI
 * assistants lift answers from a block like this, so each answer stands on
 * its own and names the event.
 */
export function buildFaq(f: OverviewFacts): { question: string; answer: string }[] {
  const { event } = f;
  const faq: { question: string; answer: string }[] = [];
  const kind = event.eventType ? KIND[event.eventType] : "event";
  faq.push({
    question: `When and where is ${event.name}?`,
    answer: `${event.name} takes place ${f.dates}${where(event) ? `, ${where(event)}` : ""}.${event.eventType === "HYBRID" ? " You can attend in person or online." : ""}`,
  });
  if (event.cmeHours) {
    const by = f.accreditors.length > 0 ? `, accredited by ${f.accreditors.join(" and ")}` : "";
    faq.push({
      question: `How many CME hours does ${event.name} carry?`,
      answer: `${event.name} carries ${event.cmeHours.toString()} CME hours${by}. Certificates are issued after the event to registered attendees.`,
    });
  }
  if (f.audiences.length > 0) {
    faq.push({
      question: `Who can attend ${event.name}?`,
      answer: `This ${event.specialty ? `${event.specialty} ` : ""}${kind} is open to ${f.audiences.join(", ")}. Each has its own registration type.`,
    });
  }
  if (f.offer && f.state !== "ended") {
    faq.push({
      question: `How much does it cost to register for ${event.name}?`,
      answer: f.offer.price === 0 ? "Registration is free." : `Registration starts at ${formatCurrency(f.offer.price, f.offer.currency)}; the price depends on your registration type.`,
    });
  }
  if (f.state === "open") {
    faq.push({
      question: `How do I register for ${event.name}?`,
      answer: `Choose Register on this page, pick your registration type and complete the form. A confirmation email follows, and your registration is in My events at ${f.origin}/my-registration.`,
    });
  }
  if (event.cmeHours) {
    faq.push({
      question: "How do I get my CME certificate?",
      answer: `Once issued, your certificate is emailed to you and can be downloaded any time from My events at ${f.origin}/my-registration.`,
    });
  }
  return faq;
}

const AVAILABILITY: Record<RegistrationState, string | null> = {
  open: "https://schema.org/InStock",
  "sold-out": "https://schema.org/SoldOut",
  closed: null,
  ended: null,
};

/**
 * The page's structured data: the Event (with price, availability, faculty
 * and a real description), the breadcrumb back to the catalogue, and the
 * questions as an FAQPage.
 */
export function eventPageJsonLd(
  f: OverviewFacts & {
    description: string;
    organization: { name: string } | null;
    speakers: { name: string; jobTitle: string | null; organization: string | null }[];
    listed: boolean;
  },
) {
  const base = eventJsonLd(f.event, f.origin, f.organization);
  const availability = AVAILABILITY[f.state];
  const event = {
    ...base,
    description: f.description,
    ...(f.offer && {
      offers: {
        "@type": "Offer",
        price: f.offer.price.toFixed(2),
        priceCurrency: f.offer.currency,
        url: `${f.origin}/e/${f.event.slug}/register`,
        ...(availability && { availability }),
      },
      ...(f.offer.price === 0 && { isAccessibleForFree: true }),
    }),
    ...(f.speakers.length > 0 && {
      performer: f.speakers.map((s) => ({
        "@type": "Person",
        name: s.name,
        ...(s.jobTitle && { jobTitle: s.jobTitle }),
        ...(s.organization && { worksFor: { "@type": "Organization", name: s.organization } }),
      })),
    }),
  };
  const faq = buildFaq(f);
  return {
    "@context": "https://schema.org",
    "@graph": [
      event,
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          ...(f.listed ? [{ "@type": "ListItem", position: 1, name: "Event catalogue", item: `${f.origin}/catalogue` }] : []),
          { "@type": "ListItem", position: f.listed ? 2 : 1, name: f.event.name, item: `${f.origin}/e/${f.event.slug}` },
        ],
      },
      ...(faq.length > 0
        ? [
            {
              "@type": "FAQPage",
              mainEntity: faq.map((q) => ({ "@type": "Question", name: q.question, acceptedAnswer: { "@type": "Answer", text: q.answer } })),
            },
          ]
        : []),
    ],
  };
}

/** A Google Maps search for the venue: no API key, and the venue is already public. */
export function mapsUrl(event: Pick<SeoEvent, "venue" | "city" | "country">): string | null {
  const q = [event.venue, event.city, event.country].filter(Boolean).join(", ");
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}
