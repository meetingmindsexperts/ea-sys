import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Award, Calendar, LayoutList, MapPin } from "lucide-react";
import { calendarDaysBetween, formatEventDateRange } from "@/lib/event-time";
import { EVENT_TYPE_LABEL, topicHref, type Topic, type TopicKind } from "@/lib/catalogue";
import type { CardRegistration, CatalogueEvent, SiteOrganization, SiteStats } from "@/lib/catalogue-data";
import { HeroPhoto } from "@/components/catalogue/hero-photo";

/**
 * The pieces the catalogue and its topic pages share (Nov 4, 2026; redesigned
 * Nov 5 after the owner compared it with motamarat.kfshrc.edu.sa: "our page
 * looks like an intern did it"). Server components; the banner fan is the one
 * client piece, in banner-fan.tsx.
 *
 * The look: a deep navy hero (the organisation's photo under a navy wash, or
 * an ECG-paper pattern without one), Fraunces for headlines (the event page's
 * face, so the two read as one site), Geist for text, Geist Mono for dates
 * and figures. Mobile first throughout.
 */

const DISPLAY = "font-[family-name:var(--font-api-display)]";

// ── Hero ───────────────────────────────────────────────────────────────────

export function CatalogueHero({
  organization,
  signedIn,
  children,
  aside,
  overlap = false,
}: {
  organization: SiteOrganization | null;
  signedIn: boolean;
  children: ReactNode;
  /** Shown beside the text from `lg`, below it on a phone (the banner fan). */
  aside?: ReactNode;
  /** Leave room for a panel that overlaps the hero's bottom edge (the search). */
  overlap?: boolean;
}) {
  return (
    <header className="relative isolate overflow-hidden bg-[#0a1c2e] text-white">
      <HeroBackdrop photo={organization?.catalogue.heroImage ?? null} />
      <CatalogueNav organization={organization} signedIn={signedIn} />
      <div
        className={`relative z-[2] mx-auto grid max-w-7xl gap-8 px-4 pt-6 sm:px-6 lg:items-center lg:gap-10 ${aside ? "lg:grid-cols-[1.05fr_1fr]" : ""} ${overlap ? "pb-24 sm:pb-28" : "pb-12 sm:pb-16"} sm:pt-10`}
      >
        <div className="grid min-w-0 gap-5 sm:gap-6">{children}</div>
        {aside}
      </div>
    </header>
  );
}

/**
 * The pattern always, the photo over it when there is one: a photo removed
 * from the media library (nothing tracks the reference) leaves the pattern,
 * not a broken image under a wash.
 */
function HeroBackdrop({ photo }: { photo: string | null }) {
  return (
    <div aria-hidden="true" className="catalogue-ecg-paper absolute inset-0 z-0">
      {photo ? <HeroPhoto src={photo} /> : <HeartbeatTrace />}
    </div>
  );
}

function HeartbeatTrace() {
  return (
    <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="absolute inset-x-0 bottom-2 h-[80px] w-full sm:bottom-4">
      <path
        className="catalogue-ecg-trace"
        d="M0 70 H240 l12 -6 l12 6 H300 l8 10 l14 -70 l14 92 l10 -32 H380 l16 -12 l18 12 H640 l12 -6 l12 6 H700 l8 10 l14 -70 l14 92 l10 -32 H780 l16 -12 l18 12 H1040 l12 -6 l12 6 H1100 l8 10 l14 -70 l14 92 l10 -32 H1200"
      />
    </svg>
  );
}

function CatalogueNav({ organization, signedIn }: { organization: SiteOrganization | null; signedIn: boolean }) {
  return (
    <nav aria-label="Site" className="relative z-[3] mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5">
      <Link href="/catalogue" className="flex min-w-0 items-center gap-2.5 font-semibold">
        {organization?.logo ? (
          // White on the navy hero; the logo file stays whatever was uploaded.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={organization.logo} alt={organization.name} className="h-8 max-w-[120px] shrink-0 object-contain brightness-0 invert" />
        ) : (
          <span className="truncate">{organization?.name ?? "Events"}</span>
        )}
      </Link>
      <div className="flex items-center gap-6 text-sm text-white/80">
        <Link href="/catalogue#events" className="hidden hover:text-white md:inline">Events</Link>
        {/* A section the organisation hid (Settings, Catalogue) has no link. */}
        {organization?.catalogue.showTopics !== false && <Link href="/catalogue#topics" className="hidden hover:text-white md:inline">Specialties</Link>}
        {organization?.catalogue.showHowItWorks !== false && <Link href="/catalogue#how" className="hidden hover:text-white md:inline">How it works</Link>}
        {signedIn ? (
          <Link
            href="/my-account"
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 font-medium text-[#0a1c2e] transition-colors hover:bg-[#dff5fc]"
          >
            <LayoutList className="h-4 w-4" />
            My events
          </Link>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/login?callbackUrl=%2Fmy-registration"
              className="rounded-full border border-white/35 px-4 py-2 text-white transition-colors hover:border-white hover:bg-white/10"
            >
              Sign in
            </Link>
            {/* Below sm only Sign in fits; the sign-in page links here too. */}
            <Link
              href="/signup"
              className="hidden rounded-full bg-white px-4 py-2 font-medium text-[#0a1c2e] transition-colors hover:bg-[#dff5fc] sm:inline-block"
            >
              Create an account
            </Link>
          </div>
        )}
      </div>
    </nav>
  );
}

export function HeroEyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs uppercase tracking-[0.14em] text-[#7fd8f3]">{children}</p>;
}

export function HeroTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className={`${DISPLAY} max-w-[16ch] text-[2.25rem] font-normal leading-[1.04] tracking-[-0.02em] text-balance sm:text-5xl lg:text-[3.6rem] [&_em]:text-[#8fe0f7]`}>
      {children}
    </h1>
  );
}

export function HeroLede({ children }: { children: ReactNode }) {
  return <p className="max-w-[52ch] text-base text-white/80 sm:text-[1.05rem]">{children}</p>;
}

/**
 * The organisation's track record, counted from the database. Hidden for a
 * new organisation (fewer than three events), where small numbers would
 * undersell it rather than reassure.
 */
export function HeroStats({ stats }: { stats: SiteStats }) {
  if (stats.events < 3) return null;
  const n = (v: number) => v.toLocaleString("en-US");
  const items = [
    [n(stats.events), stats.events === 1 ? "event hosted" : "events hosted"],
    [n(stats.delegates), "delegates registered"],
    [n(stats.faculty), "faculty"],
    [n(stats.countries), stats.countries === 1 ? "country" : "countries"],
  ].filter(([v]) => v !== "0");
  return (
    <dl className="grid max-w-[640px] grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/15 bg-white/15 backdrop-blur-sm sm:grid-cols-4">
      {items.map(([value, label]) => (
        <div key={label} className="flex flex-col-reverse gap-0.5 bg-[#0a1c2e]/60 px-4 py-3.5">
          <dt className="text-xs text-white/70">{label}</dt>
          <dd className={`${DISPLAY} text-[1.7rem] font-semibold leading-tight tabular-nums`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Listing ────────────────────────────────────────────────────────────────

export function SectionHead({ title, children, id }: { title: string; children?: ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <h2 id={id} className={`${DISPLAY} text-2xl font-semibold tracking-[-0.01em] text-[#13222f] sm:text-[1.65rem]`}>
        {title}
      </h2>
      {children}
    </div>
  );
}

export function WhenTabs({ when, hrefFor }: { when: "upcoming" | "past"; hrefFor: (when: "upcoming" | "past") => string }) {
  return (
    <nav className="inline-flex rounded-full bg-[#e8eff4] p-1 text-sm" aria-label="Upcoming or past events">
      {(["upcoming", "past"] as const).map((w) => (
        <Link
          key={w}
          href={hrefFor(w)}
          aria-current={when === w ? "page" : undefined}
          className={
            when === w
              ? "rounded-full bg-white px-4 py-1.5 font-medium text-[#13222f] shadow-sm"
              : "rounded-full px-4 py-1.5 text-[#5a6b7b] hover:text-[#13222f]"
          }
        >
          {w === "upcoming" ? "Upcoming" : "Past"}
        </Link>
      ))}
    </nav>
  );
}

export function EmptyEvents({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-2xl bg-white px-6 py-14 text-center ring-1 ring-[#dbe4eb]">
      <Calendar className="mx-auto h-10 w-10 text-[#b7c6d2]" />
      <p className="mt-3 font-medium text-[#13222f]">{title}</p>
      <p className="mt-1 text-sm text-[#5a6b7b]">{hint}</p>
    </div>
  );
}

export function Pager({ page, pages, hrefFor }: { page: number; pages: number; hrefFor: (page: number) => string }) {
  if (pages <= 1) return null;
  const link = "inline-flex h-10 items-center rounded-full bg-white px-4 font-medium text-[#13222f] ring-1 ring-[#dbe4eb] hover:ring-[#0083ad]";
  return (
    <nav className="flex items-center justify-center gap-3 pt-6 text-sm" aria-label="Pages">
      {page > 1 && <Link href={hrefFor(page - 1)} className={link}>Previous</Link>}
      <span className="text-[#5a6b7b]">
        Page {page} of {pages}
      </span>
      {page < pages && <Link href={hrefFor(page + 1)} className={link}>Next</Link>}
    </nav>
  );
}

/** A price without cents when it has none: "$400", "$149.50". */
export function priceText(price: number, currency: string): string {
  if (price === 0) return "Free";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(price);
}

/** The status chip on a card and on the next-event panel, from the one public rule. */
function StatePill({ reg }: { reg: CardRegistration | undefined }) {
  if (!reg || reg.state === "ended") return null;
  const tone = {
    open: "bg-[#e3f4ec] text-[#127a52]",
    "sold-out": "bg-[#fdf0dc] text-[#8a5a07]",
    closed: "bg-[#eef2f5] text-[#5a6b7b]",
  }[reg.state];
  const label = { open: reg.rate ?? "Registration open", "sold-out": "Sold out", closed: "Registration closed" }[reg.state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** "15–17 JAN 2027" or "30 JAN – 2 FEB 2027", in the event's own timezone. */
function dateLine(start: Date, end: Date, timeZone: string): string {
  const part = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone, ...o }).format(d);
  const [sd, ed] = [part(start, { day: "numeric" }), part(end, { day: "numeric" })];
  const [sm, em] = [part(start, { month: "short" }).toUpperCase(), part(end, { month: "short" }).toUpperCase()];
  const year = part(end, { year: "numeric" });
  if (sm !== em) return `${sd} ${sm} – ${ed} ${em} ${year}`;
  return sd === ed ? `${sd} ${sm} ${year}` : `${sd}–${ed} ${sm} ${year}`;
}

/** Venue and city, without the city twice when the venue already names it ("Mövenpick Ghala, Muscat"). */
function placeLine(venue: string | null, city: string | null): string {
  if (!venue) return city ?? "";
  if (!city || venue.toLowerCase().includes(city.trim().toLowerCase())) return venue;
  return `${venue}, ${city}`;
}

export function EventGrid({ events, registration, upcoming }: { events: CatalogueEvent[]; registration: Map<string, CardRegistration>; upcoming: boolean }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {events.map((event) => (
        <li key={event.id}>
          <EventCard event={event} reg={registration.get(event.id)} upcoming={upcoming} />
        </li>
      ))}
    </ul>
  );
}

function EventCard({ event, reg, upcoming }: { event: CatalogueEvent; reg: CardRegistration | undefined; upcoming: boolean }) {
  const where = event.eventType === "WEBINAR" ? "Online" : placeLine(event.venue, event.city) || event.country;
  const block = dateLine(event.startDate, event.endDate, event.timezone);
  const offer = upcoming && reg?.state !== "closed" ? reg?.offer : null;
  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-[#dbe4eb] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_22px_40px_-26px_rgb(10_28_46/0.5)] motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <div className="relative bg-[#e8eff4] p-3">
        <CardImage event={event} />
        {event.cmeHours && (
          <span className="absolute right-5 top-5 inline-flex items-center gap-1 rounded-full bg-[#0a1c2e] px-2.5 py-1 text-xs font-semibold text-white">
            <Award className="h-3.5 w-3.5 text-[#7fd8f3]" />
            {event.cmeHours.toString()} CME
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 px-5 pb-5 pt-4">
        <p className="font-mono text-xs tracking-[0.08em] text-[#0083ad]">
          <time dateTime={event.startDate.toISOString()}>{block}</time>
        </p>
        <h3 className="line-clamp-3 text-[1.05rem] font-semibold leading-snug text-[#13222f]">
          <Link href={`/e/${event.slug}`} className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-[#00aade]">
            {event.name}
          </Link>
        </h3>
        <p className="flex items-start gap-1.5 text-sm text-[#5a6b7b]">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {where}
          </span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {event.eventType && <span className="rounded-md bg-[#f3f7fa] px-2 py-0.5 text-xs text-[#5a6b7b]">{EVENT_TYPE_LABEL[event.eventType]}</span>}
          {event.specialty && <span className="rounded-md bg-[#f3f7fa] px-2 py-0.5 text-xs text-[#5a6b7b]">{event.specialty}</span>}
        </div>
        <div className="mt-auto flex items-center justify-between gap-3 border-t border-[#dbe4eb] pt-3">
          {offer ? (
            <span className="text-sm text-[#5a6b7b]">
              {offer.price === 0 ? (
                <b className="text-base font-semibold text-[#127a52]">Free</b>
              ) : (
                <>
                  From <b className="text-base font-semibold tabular-nums text-[#13222f]">{priceText(offer.price, offer.currency)}</b>
                </>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm font-medium text-[#0083ad]">
              View event <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          )}
          {upcoming && <StatePill reg={reg} />}
        </div>
      </div>
    </article>
  );
}

/**
 * The card's picture, framed so a white banner never melts into a white card.
 * The mobile banner (about 16:9) fills the frame; the desktop banner is a
 * wide strip that a crop would cut to a sliver, so it is shown whole.
 */
function CardImage({ event }: { event: CatalogueEvent }) {
  const src = event.bannerImageMobile ?? event.bannerImage;
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className="block aspect-[16/9] w-full rounded-lg bg-white object-contain" />;
  }
  return (
    <div className="catalogue-ecg-paper flex aspect-[16/9] w-full items-center justify-center rounded-lg p-6 text-center">
      <span className={`${DISPLAY} text-lg font-semibold text-white`}>{event.name}</span>
    </div>
  );
}

// ── Next event ─────────────────────────────────────────────────────────────

/**
 * The soonest listed event, large: its banner, a countdown, and what each
 * registration type pays today, read by the same rule as the form.
 */
export function NextUp({ event, reg, now }: { event: CatalogueEvent; reg: CardRegistration | undefined; now: Date }) {
  const days = calendarDaysBetween(now, event.startDate, event.timezone);
  const where = event.eventType === "WEBINAR" ? "Online" : [placeLine(event.venue, event.city), event.country].filter(Boolean).join(", ");
  const rows = groupRates(reg?.rates ?? []);
  const open = reg?.state === "open";
  return (
    <article className="grid overflow-hidden rounded-[18px] bg-white ring-1 ring-[#dbe4eb] lg:grid-cols-[1.1fr_1fr]">
      <div className="relative grid place-items-center bg-[#e8eff4] p-4 sm:p-6">
        <CardImage event={event} />
        <span className="absolute left-7 top-7 rounded-lg bg-[#0a1c2e] px-3 py-1.5 font-mono text-xs tracking-wide text-white sm:left-9 sm:top-9">
          <Countdown days={days} started={now >= event.startDate} />
        </span>
      </div>
      <div className="grid content-start gap-4 p-5 sm:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <StatePill reg={reg} />
          {event.eventType && <span className="rounded-md bg-[#f3f7fa] px-2 py-0.5 text-xs text-[#5a6b7b]">{EVENT_TYPE_LABEL[event.eventType]}</span>}
          {event.specialty && <span className="rounded-md bg-[#f3f7fa] px-2 py-0.5 text-xs text-[#5a6b7b]">{event.specialty}</span>}
        </div>
        <h3 className={`${DISPLAY} text-2xl font-semibold leading-tight tracking-[-0.01em] text-[#13222f] sm:text-[1.7rem]`}>
          <Link href={`/e/${event.slug}`} className="hover:text-[#0083ad]">{event.name}</Link>
        </h3>
        <dl className="grid gap-2 text-[0.95rem] text-[#13222f]">
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 pt-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[#5a6b7b]">When</dt>
            <dd>
              <time dateTime={event.startDate.toISOString()}>{formatEventDateRange(event.startDate, event.endDate, event.timezone)}</time>
            </dd>
          </div>
          {where && (
            <div className="flex gap-3">
              <dt className="w-16 shrink-0 pt-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[#5a6b7b]">Where</dt>
              <dd className="min-w-0">{where}</dd>
            </div>
          )}
          {event.cmeHours && (
            <div className="flex gap-3">
              <dt className="w-16 shrink-0 pt-0.5 font-mono text-[11px] uppercase tracking-[0.1em] text-[#5a6b7b]">CME</dt>
              <dd>{event.cmeHours.toString()} hours</dd>
            </div>
          )}
        </dl>
        {rows.length > 0 && (
          <div className="grid gap-1.5 border-t border-[#dbe4eb] pt-4">
            <p className="flex justify-between font-mono text-[11px] uppercase tracking-[0.1em] text-[#5a6b7b]">
              <span>{reg?.rate ? `${reg.rate} rates` : "Rates"}</span>
              {/* Only when every row is in it; mixed currencies show on each price. */}
              {rows.every((r) => r.currency === rows[0].currency) && <span>{rows[0].currency}</span>}
            </p>
            {rows.map((r) => (
              <p key={r.types} className="flex justify-between gap-4 text-[0.95rem]">
                <span className="min-w-0 text-[#13222f]">{r.types}</span>
                <span className={`font-semibold tabular-nums ${r.price === 0 ? "text-[#127a52]" : "text-[#13222f]"}`}>{priceText(r.price, r.currency)}</span>
              </p>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2.5 pt-1">
          {open && (
            <Link
              href={`/e/${event.slug}/register`}
              className="inline-flex h-12 items-center justify-center rounded-xl bg-[#00aade] px-6 font-semibold text-[#032636] transition-colors hover:bg-[#22bbea]"
            >
              Register now
            </Link>
          )}
          <Link
            href={`/e/${event.slug}`}
            className="inline-flex h-12 items-center justify-center rounded-xl px-5 font-medium text-[#13222f] ring-1 ring-[#dbe4eb] transition hover:ring-[#0083ad]"
          >
            Programme and details
          </Link>
        </div>
      </div>
    </article>
  );
}

function Countdown({ days, started }: { days: number; started: boolean }) {
  if (started) return <>Under way</>;
  if (days <= 0) return <>Starts today</>;
  return (
    <>
      <b className="mr-1 text-[15px] tabular-nums">{days}</b>
      {days === 1 ? "day to go" : "days to go"}
    </>
  );
}

/** Types paying the same price share a row: "Resident, Student · Free". */
function groupRates(rates: CardRegistration["rates"]) {
  const rows: { types: string; price: number; currency: string }[] = [];
  for (const r of rates) {
    const row = rows.find((x) => x.price === r.price && x.currency === r.currency);
    if (row) row.types = `${row.types}, ${r.type}`;
    else rows.push({ types: r.type, price: r.price, currency: r.currency });
  }
  return rows.sort((a, b) => b.price - a.price);
}

// ── How it works, topics, footer ───────────────────────────────────────────

/** A real sequence, so it is numbered. */
export function HowItWorks() {
  const steps = [
    ["Choose an event", "Each event page lists the dates, venue, programme, faculty and rates."],
    ["Register and pay online", "Pick your registration type and pay online. Your account is created as you register."],
    ["Download your certificate", "After the event, your certificates appear in My events, ready to download."],
  ];
  return (
    <ol className="grid gap-px overflow-hidden rounded-2xl bg-[#dbe4eb] ring-1 ring-[#dbe4eb] md:grid-cols-3">
      {steps.map(([title, text], i) => (
        <li key={title} className="grid content-start gap-1.5 bg-white px-5 py-5 sm:px-6">
          <span className="font-mono text-xs text-[#0083ad]">{i + 1}</span>
          <b className="font-semibold text-[#13222f]">{title}</b>
          <p className="text-sm text-[#5a6b7b]">{text}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Links to every topic page: how a person browses by subject, and the
 * internal links that let search engines find those pages.
 */
export function BrowseTopics({ specialties, countries, current }: { specialties: Topic[]; countries: Topic[]; current?: { kind: TopicKind; slug: string } }) {
  const tiles = [
    ...specialties.map((t) => ({ kind: "specialty" as const, label: "Specialty", topic: t })),
    ...countries.map((t) => ({ kind: "country" as const, label: "Country", topic: t })),
  ];
  if (tiles.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map(({ kind, label, topic }) => {
        const active = current?.kind === kind && current.slug === topic.slug;
        return (
          <li key={`${kind}-${topic.slug}`}>
            <Link
              href={topicHref(kind, topic.label)}
              aria-current={active ? "page" : undefined}
              className={`grid h-full content-start gap-1 rounded-2xl p-4 ring-1 transition ${active ? "bg-[#0a1c2e] text-white ring-[#0a1c2e]" : "bg-white text-[#13222f] ring-[#dbe4eb] hover:ring-[#0083ad]"}`}
            >
              <span className={`font-mono text-[10.5px] uppercase tracking-[0.12em] ${active ? "text-[#7fd8f3]" : "text-[#5a6b7b]"}`}>{label}</span>
              <span className={`${DISPLAY} text-lg font-semibold leading-snug`}>{topic.label}</span>
              <span className={`mt-1 inline-flex items-center gap-1 text-sm ${active ? "text-white/75" : "text-[#0083ad]"}`}>
                {active ? "You are here" : "View events"}
                {!active && <ArrowRight className="h-3.5 w-3.5" />}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function CatalogueFooter({ organization, specialties }: { organization: SiteOrganization | null; specialties: Topic[] }) {
  const name = organization?.name ?? "Events";
  const contact = [organization?.email, organization?.phone].filter((v): v is string => !!v);
  const heading = "mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-[#7fd8f3]";
  return (
    <footer className="mt-16 bg-[#0a1c2e] text-sm text-white/75">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 pb-8 pt-10 sm:px-6 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div className="col-span-2 grid max-w-[40ch] content-start gap-3 md:col-span-1">
          {organization?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={organization.logo} alt={name} className="h-8 w-auto max-w-[140px] justify-self-start object-contain brightness-0 invert" />
          ) : (
            <span className="font-semibold text-white">{name}</span>
          )}
          <p>{organization?.catalogue.footerAbout ?? `Medical conferences, workshops and webinars${organization ? `, organised by ${organization.name}` : ""}.`}</p>
        </div>
        <div>
          <h2 className={heading}>Events</h2>
          <ul className="grid gap-1.5">
            <li><Link href="/catalogue" className="hover:text-white">Upcoming</Link></li>
            <li><Link href="/catalogue?when=past" className="hover:text-white">Past events</Link></li>
            {specialties.slice(0, 4).map((t) => (
              <li key={t.slug}><Link href={topicHref("specialty", t.label)} className="hover:text-white">{t.label}</Link></li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className={heading}>Attendees</h2>
          <ul className="grid gap-1.5">
            <li><Link href="/my-account" className="hover:text-white">My events</Link></li>
            <li><Link href="/my-account/certificates" className="hover:text-white">Certificates</Link></li>
            <li><Link href="/login?callbackUrl=%2Fmy-registration" className="hover:text-white">Sign in</Link></li>
          </ul>
        </div>
        {contact.length > 0 && (
          <div>
            <h2 className={heading}>Contact</h2>
            <ul className="grid gap-1.5">
              {organization?.email && <li><a href={`mailto:${organization.email}`} className="break-all hover:text-white">{organization.email}</a></li>}
              {organization?.phone && <li><a href={`tel:${organization.phone.replace(/[^\d+]/g, "")}`} className="hover:text-white">{organization.phone}</a></li>}
            </ul>
          </div>
        )}
      </div>
      <div className="mx-auto flex max-w-7xl flex-wrap justify-between gap-2 border-t border-white/10 px-4 py-4 text-xs text-white/60 sm:px-6">
        <span>© {new Date().getFullYear()} {name}</span>
        <span>Rates and dates are confirmed on each event&apos;s page.</span>
      </div>
    </footer>
  );
}
