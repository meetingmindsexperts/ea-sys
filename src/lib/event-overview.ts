import type { EventType } from "@prisma/client";
import type { AccreditationEntry } from "@/lib/certificates/types";
import { friendlyAccreditorName } from "@/lib/certificates/template";
import { formatCurrency } from "@/lib/utils";
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

/** A seat the public can buy: what the public registration API sells. */
export interface PublicTicketType {
  price: { toString(): string };
  currency: string;
  quantity: number;
  soldCount: number;
  salesStart: Date | null;
  salesEnd: Date | null;
  pricingTiers: {
    price: { toString(): string };
    currency: string;
    quantity: number;
    soldCount: number;
    salesStart: Date | null;
    salesEnd: Date | null;
  }[];
}

export interface PublicOffer {
  /** Lowest price on sale now, in the currency it is sold in. */
  price: number;
  currency: string;
  /** Something can be bought right now. */
  onSale: boolean;
  /** Every window is open but every seat is taken. */
  soldOut: boolean;
}

function windowOpen(w: { salesStart: Date | null; salesEnd: Date | null }, now: Date): boolean {
  return (!w.salesStart || w.salesStart <= now) && (!w.salesEnd || w.salesEnd >= now);
}

/**
 * The lowest price someone can register at now, the way the public API
 * decides availability: a tier is bought within its type's seats (the type is
 * the ceiling), a type without tiers sells on its own window. Types and tiers
 * whose window is shut do not set the price; if nothing is on sale, the
 * lowest listed price is still shown so the page can say "from".
 *
 * A free type (exhibitor, student, a sponsored delegate) does not set the
 * "from" price while any paid type exists: "Free" on a paid conference would
 * mislead the reader and Google's event result alike. Free only when every
 * type is free.
 */
export function lowestPublicOffer(types: PublicTicketType[], now: Date): PublicOffer | null {
  const candidates: { price: number; currency: string; onSale: boolean; open: boolean }[] = [];
  for (const t of types) {
    const typeLeft = t.quantity - t.soldCount;
    const sellables = t.pricingTiers.length > 0 ? t.pricingTiers : [t];
    for (const s of sellables) {
      const left = Math.min(s.quantity - s.soldCount, typeLeft);
      const open = windowOpen(s, now);
      candidates.push({ price: Number(s.price.toString()), currency: s.currency, onSale: open && left > 0, open });
    }
  }
  if (candidates.length === 0) return null;
  const paid = candidates.filter((c) => c.price > 0);
  const priced = paid.length > 0 ? paid : candidates;
  const pool = priced.some((c) => c.onSale) ? priced.filter((c) => c.onSale) : priced;
  const best = pool.reduce((a, b) => (b.price < a.price ? b : a));
  return {
    price: best.price,
    currency: best.currency,
    onSale: candidates.some((c) => c.onSale),
    soldOut: candidates.every((c) => c.open) && !candidates.some((c) => c.onSale),
  };
}

export function offerLabel(offer: PublicOffer): string {
  return offer.price === 0 ? "Free" : `From ${formatCurrency(offer.price, offer.currency)}`;
}

export type RegistrationState = "open" | "closed" | "sold-out" | "ended";

/** What the call to action says: register, closed, full, or over. */
export function registrationState(input: { endDate: Date; registrationOpen: boolean; offer: PublicOffer | null }, now: Date): RegistrationState {
  if (input.endDate < now) return "ended";
  if (!input.registrationOpen || !input.offer) return "closed";
  if (input.offer.soldOut) return "sold-out";
  return input.offer.onSale ? "open" : "closed";
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
