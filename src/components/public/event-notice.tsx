"use client";

/**
 * The branded frame a public event page shows when it has a message instead of
 * its content: "the agenda is not live yet", "registration is closed", "this
 * link no longer works" (Nov 17, 2026).
 *
 * Every such state used to be a bare card on a blank screen, about twenty of
 * them, each written by hand, because a page took its banner and footer from
 * the request that had just failed. The branding now arrives from the public
 * `[slug]` layout (`event-branding-context.tsx`), so the frame is the
 * same as the working page's: banner band, the event's name, dates and place,
 * the message, and the event's footer.
 *
 * RULE: a public page under `/e/[slug]` shows a full-page message through
 * `PublicEventNotice`, never its own `min-h-screen` card
 * (`public-event-notice.test.ts` fails on a new one).
 *
 * With no branding to show (no such event, a draft, a failed lookup) the frame
 * keeps the thin brand-colour stripe the forms use when an event has no
 * banner, and the message stands alone.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertCircle, Calendar, MapPin, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";
import { DEFAULT_EVENT_TIMEZONE, formatEventDateRange, knownTimezone } from "@/lib/event-time";
import type { PublicEventBranding } from "@/lib/public-event-branding";
import { EventBannerBand } from "@/components/public/event-banner";
import { usePublicEventBranding } from "@/components/public/event-branding-context";

export { usePublicEventBranding };

/** The event's own footer (Settings, Branding), at the width of the page body. */
export function PublicEventFooter({ footerHtml, className }: { footerHtml?: string | null; className?: string }) {
  if (!footerHtml) return null;
  return (
    <div className={cn("w-full border-t border-slate-200/60 bg-white text-center py-6", className)}>
      <div
        className="prose prose-slate max-w-5xl mx-auto px-4 sm:px-6 [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(footerHtml) }}
      />
    </div>
  );
}

function eventDateLine(event: PublicEventBranding): string | null {
  if (!event.startDate) return null;
  const start = new Date(event.startDate);
  const end = event.endDate ? new Date(event.endDate) : start;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  // The timezone column takes any string, and one Intl does not know makes
  // every format call throw. A message page must not crash over its date line.
  return formatEventDateRange(start, end, knownTimezone(event.timezone) ?? DEFAULT_EVENT_TIMEZONE);
}

function EventInfoStrip({ event }: { event: PublicEventBranding }) {
  const dateLine = eventDateLine(event);
  const location = [event.venue, event.city, event.country].filter(Boolean).join(", ");
  return (
    <div className="bg-white border-b border-slate-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
          <p className="text-base font-semibold text-slate-800 mr-auto">{event.name}</p>
          {dateLine && (
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <Calendar className="h-3.5 w-3.5 text-primary/70" />
              <span>{dateLine}</span>
            </div>
          )}
          {location && (
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <MapPin className="h-3.5 w-3.5 text-primary/70" />
              <span>{location}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const TONES = {
  /** Nothing is wrong: not open yet, closed, finished. */
  neutral: { chip: "bg-slate-100", icon: "text-slate-400" },
  /** Something the visitor should know about and can act on. */
  info: { chip: "bg-sky-50", icon: "text-primary" },
  /** The link or the load failed. */
  error: { chip: "bg-red-50", icon: "text-red-500" },
} as const;

export interface PublicEventNoticeProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: keyof typeof TONES;
  /** Links and buttons under the message. */
  children?: ReactNode;
  /**
   * The event, when the page already loaded it. Wins over the layout's
   * branding, so a state reached with the event in hand looks exactly like the
   * page it replaces.
   */
  event?: PublicEventBranding | null;
  /** Wider card for a message that carries a form or a longer text. */
  wide?: boolean;
  /**
   * The page asked for its event and was told there is none. When the layout
   * holds the event's public branding all the same, the event is real and this
   * part of it is closed (an event that has ended, most often), so the notice
   * says that. "Event not found" under the event's own banner contradicts
   * itself. With no branding the page's own message is shown as given.
   */
  missingEvent?: boolean;
}

/** What `missingEvent` shows for an event that exists but no longer serves the page. */
function ClosedPartOfEvent({ event, children }: { event: PublicEventBranding; children?: ReactNode }) {
  const params = useParams<{ slug?: string }>();
  return (
    <NoticeFrame
      branding={event}
      icon={AlertCircle}
      tone="neutral"
      title="This page is not available"
      description={`This part of ${event.name} is not open at the moment. The event may have ended, or this page may have closed.`}
    >
      {/* The page's own way out when it gave one, else the event's page. */}
      {children ??
        (params?.slug ? (
          <Link href={`/e/${params.slug}`} className="text-primary text-sm font-medium hover:underline">
            Back to event page
          </Link>
        ) : null)}
    </NoticeFrame>
  );
}

export function PublicEventNotice({
  title,
  description,
  icon = AlertCircle,
  tone = "neutral",
  children,
  event,
  wide = false,
  missingEvent = false,
}: PublicEventNoticeProps) {
  const fromLayout = usePublicEventBranding();
  if (missingEvent && fromLayout) return <ClosedPartOfEvent event={fromLayout}>{children}</ClosedPartOfEvent>;
  return (
    <NoticeFrame
      branding={event ?? fromLayout}
      icon={icon}
      tone={tone}
      title={title}
      description={description}
      wide={wide}
    >
      {children}
    </NoticeFrame>
  );
}

function NoticeFrame({
  branding,
  icon: Icon,
  tone,
  title,
  description,
  wide = false,
  children,
}: {
  branding: PublicEventBranding | null;
  icon: LucideIcon;
  tone: keyof typeof TONES;
  title: string;
  description?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}) {
  const hasBanner = Boolean(branding?.bannerImage || branding?.bannerImageMobile);
  const colours = TONES[tone];

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]" data-public-event-notice>
      {branding && hasBanner ? (
        <EventBannerBand banner={branding.bannerImage} bannerMobile={branding.bannerImageMobile} name={branding.name} />
      ) : (
        <div className="bg-white border-b border-slate-100">
          <div className="h-1 bg-gradient-primary" />
        </div>
      )}

      {branding && <EventInfoStrip event={branding} />}

      <main className="flex-1 flex items-center justify-center px-4 py-10 sm:py-14">
        <div
          className={cn(
            "bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full text-center",
            wide ? "max-w-lg" : "max-w-md",
          )}
        >
          <div className={cn("mx-auto mb-4 h-14 w-14 rounded-full flex items-center justify-center", colours.chip)}>
            <Icon className={cn("h-7 w-7", colours.icon)} aria-hidden />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 mb-2">{title}</h1>
          {description && <div className="text-slate-500 text-sm leading-relaxed">{description}</div>}
          {children && <div className="mt-5 flex flex-col items-center gap-3">{children}</div>}
        </div>
      </main>

      <PublicEventFooter footerHtml={branding?.footerHtml} />
    </div>
  );
}
