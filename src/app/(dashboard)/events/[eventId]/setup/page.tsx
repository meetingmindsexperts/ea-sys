/**
 * Event Setup Hub — single page showing every configure-once / non-
 * daily-use item in one grid. Replaces what used to be 6 individual
 * sidebar entries (Registration Types, Survey, Certificates,
 * Sponsors, Content, Media) — now reachable from a single sidebar
 * "Setup" link to keep the daily-use sidebar slim for registration,
 * abstracts, and program teams who don't touch these items often.
 *
 * Each card shows:
 *   - Color-coded icon badge (matches the visual language of the
 *     event landing page's stat tiles)
 *   - Title + one-line description
 *   - Status pill: configured / not-configured / count-where-cheap
 *   - Whole card is a Link to the underlying existing page (no
 *     route renames; just adds a hub layer above them)
 *
 * Status check strategy:
 *   - All status data fetched in ONE Promise.all alongside the
 *     event lookup — single round-trip to Postgres for the whole
 *     page render
 *   - Counts where they're informative ("3 templates", "12 questions");
 *     boolean configured/not where counts add no value
 *   - When a status fetch fails individually, the card falls back
 *     to "Status unavailable" rather than crashing the whole page
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Award,
  CheckCircle2,
  Circle,
  ClipboardList,
  GraduationCap,
  ImageIcon,
  Mail,
  PenLine,
  Ticket,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SetupPageProps {
  params: Promise<{ eventId: string }>;
}

// ── Card definitions ────────────────────────────────────────────────
// Each card maps a setup area to its sidebar-removed page. The order
// matches the typical event-buildout flow: registration types are
// configured first (the gate to opening registration), then content
// + sponsors for the public face, then post-event tooling (survey +
// certificates), then assets (media).

interface SetupCardConfig {
  /** Slug for the route — appended to /events/[eventId]/ */
  slug: string;
  /** Card title — short, sentence case */
  title: string;
  /** One-line description of what this configures */
  description: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Tailwind color scheme: bg + text classes for icon badge.
   *  Drawn from the existing TAG_COLORS palette so the hub fits the
   *  rest of the dashboard's visual language. */
  colorClasses: string;
  /** Border accent color when card is hovered */
  hoverBorder: string;
}

const SETUP_CARDS: SetupCardConfig[] = [
  {
    slug: "tickets",
    title: "Registration Types",
    description:
      "Ticket categories, pricing tiers, sales windows, capacity limits — the gate to opening registration.",
    icon: Ticket,
    colorClasses: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    hoverBorder: "hover:border-sky-400",
  },
  {
    slug: "content",
    title: "Content",
    description:
      "Welcome page HTML, terms & conditions, confirmation messages, speaker agreement text — what registrants and speakers see.",
    icon: PenLine,
    colorClasses:
      "bg-cyan-50 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
    hoverBorder: "hover:border-cyan-400",
  },
  {
    // Lives at /communications/templates (slug includes the path) —
    // this card cuts the operator from the Setup hub straight to the
    // templates list, bypassing the Communications page since editing
    // templates is a configure-once action, not part of the daily
    // send workflow.
    slug: "communications/templates",
    title: "Email Templates",
    description:
      "Per-event overrides for registration confirmation, speaker invitation, reminder, custom and other system email templates.",
    icon: Mail,
    colorClasses:
      "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
    hoverBorder: "hover:border-indigo-400",
  },
  {
    slug: "sponsors",
    title: "Sponsors",
    description:
      "Sponsor tiers, logos, websites — displayed on public pages and the session detail view.",
    icon: Award,
    colorClasses:
      "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    hoverBorder: "hover:border-violet-400",
  },
  {
    slug: "survey",
    title: "Survey",
    description:
      "Post-event feedback questions and response browser. Tag-driven cert gating relies on this.",
    icon: ClipboardList,
    colorClasses:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    hoverBorder: "hover:border-emerald-400",
  },
  {
    slug: "certificates",
    title: "Certificates",
    description:
      "Certificate templates, mail-merge tokens, issuance workflow, resend history. Configured once, issued post-event.",
    icon: GraduationCap,
    colorClasses:
      "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    hoverBorder: "hover:border-amber-400",
  },
  {
    slug: "media",
    title: "Media Library",
    description:
      "Event-scoped images and uploads, reusable in email templates and content pages.",
    icon: ImageIcon,
    colorClasses: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    hoverBorder: "hover:border-rose-400",
  },
];

// Status shape — one entry per slug. `configured` drives the pill;
// `count` (optional) shows next to the pill when informative.
interface SetupStatus {
  configured: boolean;
  count?: number;
  /** Set when the status fetch itself failed — renders as "Status unavailable" */
  unavailable?: boolean;
}

type StatusMap = Record<string, SetupStatus>;

// ── Page ────────────────────────────────────────────────────────────

export default async function SetupPage({ params }: SetupPageProps) {
  const [{ eventId }, session] = await Promise.all([params, auth()]);
  if (!session?.user) notFound();

  // Single round-trip: event lookup + all status counts in parallel.
  // The event row carries surveyConfig, settings.sponsors, and all
  // the content-HTML fields, so survey + sponsors + content statuses
  // come from the event read itself — no extra queries needed.
  // ticketType + certificateTemplate + mediaFile need count(*) — three
  // small queries alongside the event read.
  let result;
  try {
    result = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          // For per-card status computation:
          surveyConfig: true,
          settings: true,
          registrationWelcomeHtml: true,
          registrationTermsHtml: true,
          abstractWelcomeHtml: true,
          speakerAgreementHtml: true,
          registrationConfirmationHtml: true,
        },
      }),
      db.ticketType.count({ where: { eventId } }),
      db.certificateTemplate.count({ where: { eventId } }),
      db.mediaFile.count({ where: { eventId } }),
      // Count of per-event email template OVERRIDES — the system has
      // defaults for every template slug, but each event can override.
      // "Configured" status here means "this event has at least one
      // override" (i.e. the operator has customised something away
      // from the platform default).
      db.emailTemplate.count({ where: { eventId } }),
    ]);
  } catch (err) {
    apiLogger.error({ err, msg: "setup-hub:load-failed", eventId });
    // Soft fail — render the page with the cards but mark each
    // status as unavailable. Better than 500 because the operator
    // can still navigate to the underlying pages.
    return renderSetupWithStatusError(eventId, "Failed to load setup status");
  }

  const [
    event,
    ticketTypeCount,
    certificateTemplateCount,
    mediaFileCount,
    emailTemplateCount,
  ] = result;
  if (!event) notFound();

  // Compute per-card statuses. Each is intentionally cheap — boolean
  // for binary configure/not-configure cases, count where the number
  // itself is informative ("3 templates" tells you the cert system
  // has multiple categories configured; "configured" alone wouldn't).
  const sponsorsArray = Array.isArray(
    (event.settings as { sponsors?: unknown[] })?.sponsors,
  )
    ? ((event.settings as { sponsors?: unknown[] }).sponsors as unknown[])
    : [];
  const surveyConfigArray = Array.isArray(event.surveyConfig)
    ? (event.surveyConfig as unknown[])
    : [];
  // Content is considered configured when ANY of the HTML fields is
  // non-empty — operators may set just terms, or just welcome, etc.
  const contentConfigured = Boolean(
    event.registrationWelcomeHtml?.trim() ||
      event.registrationTermsHtml?.trim() ||
      event.abstractWelcomeHtml?.trim() ||
      event.speakerAgreementHtml?.trim() ||
      event.registrationConfirmationHtml?.trim(),
  );

  const statuses: StatusMap = {
    tickets: { configured: ticketTypeCount > 0, count: ticketTypeCount },
    content: { configured: contentConfigured },
    // Note: status keys use the slug verbatim, including the slash —
    // matches the SETUP_CARDS slug field. Bracket access avoids
    // identifier issues.
    "communications/templates": {
      configured: emailTemplateCount > 0,
      count: emailTemplateCount,
    },
    sponsors: {
      configured: sponsorsArray.length > 0,
      count: sponsorsArray.length,
    },
    survey: {
      configured: surveyConfigArray.length > 0,
      count: surveyConfigArray.length,
    },
    certificates: {
      configured: certificateTemplateCount > 0,
      count: certificateTemplateCount,
    },
    media: {
      configured: mediaFileCount > 0,
      count: mediaFileCount,
    },
  };

  return (
    <div className="container max-w-6xl py-8">
      <div className="mb-6">
        <Link
          href={`/events/${eventId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowRight className="h-3 w-3 mr-1 rotate-180" />
          Back to {event.name}
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-bold">Event Setup</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl">
          Configure-once items for this event. Daily-use tools
          (registrations, check-in, speakers, agenda, communications) stay in
          the main sidebar; the setup-once and post-event items live here so
          your sidebar isn&rsquo;t bloated for the registration, abstracts, and
          program teams who don&rsquo;t need these every day.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETUP_CARDS.map((card) => (
          <SetupCard
            key={card.slug}
            card={card}
            status={statuses[card.slug]}
            eventId={eventId}
          />
        ))}
      </div>
    </div>
  );
}

// ── Components ──────────────────────────────────────────────────────

function SetupCard({
  card,
  status,
  eventId,
}: {
  card: SetupCardConfig;
  status: SetupStatus;
  eventId: string;
}) {
  const Icon = card.icon;
  return (
    <Link
      href={`/events/${eventId}/${card.slug}`}
      className={cn(
        "group block rounded-xl border bg-card transition-all",
        "hover:shadow-md hover:-translate-y-0.5",
        card.hoverBorder,
      )}
    >
      <Card className="border-0 shadow-none h-full">
        <CardContent className="p-5 flex flex-col h-full">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center shrink-0",
                card.colorClasses,
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <StatusPill status={status} />
          </div>
          <h2 className="font-semibold text-base mb-1">{card.title}</h2>
          <p className="text-sm text-muted-foreground flex-1">
            {card.description}
          </p>
          <div className="mt-4 flex items-center text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            <span>Open</span>
            <ArrowRight className="h-3 w-3 ml-1 transition-transform group-hover:translate-x-1" />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function StatusPill({ status }: { status: SetupStatus }) {
  if (status.unavailable) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Circle className="h-3 w-3" />
        Status unavailable
      </span>
    );
  }
  if (status.configured) {
    const label =
      typeof status.count === "number" && status.count > 0
        ? `${status.count} configured`
        : "Configured";
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      <Circle className="h-3 w-3" />
      Not configured
    </span>
  );
}

// ── Error-state fallback ────────────────────────────────────────────

function renderSetupWithStatusError(eventId: string, message: string) {
  return (
    <div className="container max-w-6xl py-8">
      <div className="mb-6">
        <Link
          href={`/events/${eventId}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowRight className="h-3 w-3 mr-1 rotate-180" />
          Back to event
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-bold">Event Setup</h1>
        <p className="text-muted-foreground mt-1">{message}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETUP_CARDS.map((card) => (
          <SetupCard
            key={card.slug}
            card={card}
            status={{ configured: false, unavailable: true }}
            eventId={eventId}
          />
        ))}
      </div>
    </div>
  );
}
