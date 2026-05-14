import { notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { Card, CardContent } from "@/components/ui/card";
import { CopyLinkCard } from "@/components/ui/copy-link-card";
import {
  Calendar,
  MapPin,
  Users,
  Mic,
  Building2,
  Settings,
  ArrowRight,
  TrendingUp,
} from "lucide-react";
import { EventActions } from "./event-actions";
import { ActivityFeed } from "@/components/activity-feed";
import { formatDateRange } from "@/lib/utils";

const statusConfig: Record<string, { label: string; cls: string }> = {
  DRAFT:     { label: "Draft",     cls: "bg-white/15 text-white border-white/25" },
  PUBLISHED: { label: "Published", cls: "bg-white/15 text-white border-white/25" },
  LIVE:      { label: "Live",      cls: "bg-green-400/20 text-green-100 border-green-300/30" },
  COMPLETED: { label: "Completed", cls: "bg-white/10 text-white/80 border-white/20" },
  CANCELLED: { label: "Cancelled", cls: "bg-red-400/20 text-red-100 border-red-300/30" },
};

const statIconStyle: Record<string, string> = {
  Registrations: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300",
  Speakers:      "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300",
  Sessions:      "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300",
  Hotels:        "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300",
};

interface EventPageProps {
  params: Promise<{ eventId: string }>;
}

export default async function EventPage({ params }: EventPageProps) {
  const [{ eventId }, session] = await Promise.all([params, auth()]);
  if (!session?.user) notFound();

  let event;
  try {
    event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        country: true,
        _count: {
          select: {
            registrations: true,
            speakers: true,
            eventSessions: true,
            hotels: true,
          },
        },
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to load event detail", eventId, userId: session.user.id });
    throw error;
  }

  if (!event) notFound();

  const isRestricted =
    session.user.role === "REVIEWER" || session.user.role === "SUBMITTER";

  // ── Registrations-by-Tier breakdown ─────────────────────────────────────────
  // groupBy returns rows like { pricingTierId, _count: { _all: 42 } }. The
  // second query resolves tier ids → names + sortOrder so the dashboard can
  // group "Early Bird" across all ticket types (the Physician + Student
  // tickets each have their own Early Bird row; admins want the union).
  let tierBreakdown: Array<{ name: string; count: number; sortOrder: number }> = [];
  if (!isRestricted && event._count.registrations > 0) {
    try {
      const grouped = await db.registration.groupBy({
        by: ["pricingTierId"],
        where: {
          eventId,
          status: { notIn: ["CANCELLED"] },
          pricingTierId: { not: null },
        },
        _count: { _all: true },
      });
      const tierIds = grouped
        .map((g) => g.pricingTierId)
        .filter((x): x is string => !!x);
      if (tierIds.length > 0) {
        const tiers = await db.pricingTier.findMany({
          where: { id: { in: tierIds } },
          select: { id: true, name: true, sortOrder: true },
        });
        const tierMap = new Map(tiers.map((t) => [t.id, t]));
        const byName = new Map<
          string,
          { name: string; count: number; sortOrder: number }
        >();
        for (const g of grouped) {
          if (!g.pricingTierId) continue;
          const t = tierMap.get(g.pricingTierId);
          if (!t) continue;
          const existing = byName.get(t.name);
          if (existing) existing.count += g._count._all;
          else byName.set(t.name, { name: t.name, count: g._count._all, sortOrder: t.sortOrder });
        }
        tierBreakdown = [...byName.values()].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        );
      }
    } catch (err) {
      // Reporting tile is non-essential — if the aggregate fails, log and
      // render the dashboard without it rather than 500'ing the whole page.
      apiLogger.error({
        err,
        msg: "Failed to compute tier breakdown for event dashboard",
        eventId,
      });
    }
  }

  const sc = statusConfig[event.status] ?? statusConfig.DRAFT;
  const location = [event.venue, event.city, event.country].filter(Boolean).join(", ");

  const stats = [
    { title: "Registrations", value: event._count.registrations, icon: Users,     href: `/events/${eventId}/registrations` },
    { title: "Speakers",      value: event._count.speakers,      icon: Mic,       href: `/events/${eventId}/speakers` },
    { title: "Sessions",      value: event._count.eventSessions, icon: Calendar,  href: `/events/${eventId}/agenda` },
    { title: "Hotels",        value: event._count.hotels,        icon: Building2, href: `/events/${eventId}/accommodation` },
  ];


  // ── Contextual Quick Actions ─────────────────────────────────────────────
  const quickActions = [
    {
      title: event._count.speakers > 0
        ? "Manage Speakers"
        : "Add Your First Speaker",
      description: event._count.speakers > 0
        ? "View and manage event speakers"
        : "Invite speakers to present at your event",
      icon: Mic,
      href: `/events/${eventId}/speakers`,
      attention: event._count.speakers === 0,
      iconStyle: "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300",
    },
    {
      title: event._count.eventSessions > 0
        ? "Manage Agenda"
        : "Build Your Agenda",
      description: event._count.eventSessions > 0
        ? "Edit sessions and tracks"
        : "Create sessions and organize your event agenda",
      icon: Calendar,
      href: `/events/${eventId}/agenda`,
      attention: event._count.eventSessions === 0,
      iconStyle: "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300",
    },
    {
      title: "Event Settings",
      description: "Configure event details and preferences",
      icon: Settings,
      href: `/events/${eventId}/settings`,
      attention: false,
      iconStyle: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
    },
  ];

  return (
    <div className="space-y-6">
      {/* ── Hero Banner ─────────────────────────────────────────────────────── */}
      <div className="relative rounded-xl overflow-hidden bg-gradient-primary shadow-[0_2px_8px_rgba(0,0,0,0.1),0_8px_32px_rgba(0,0,0,0.08)]">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_0%,rgba(255,255,255,0.15),transparent_60%)]" />
        <div className="relative p-6 md:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 flex-1 min-w-0">
              <span className={`inline-flex items-center text-xs font-semibold px-2.5 py-0.5 rounded-full border ${sc.cls}`}>
                {sc.label}
              </span>
              <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight">
                {event.name}
              </h1>
              {event.description && (
                <p className="text-white/70 text-sm max-w-2xl line-clamp-2">
                  {event.description}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-1 text-sm text-white/80">
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-white/60" />
                  {formatDateRange(event.startDate, event.endDate)}
                </span>
                {location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-white/60" />
                    {location}
                  </span>
                )}
              </div>
            </div>
            {!isRestricted && (
              <EventActions eventId={eventId} eventName={event.name} />
            )}
          </div>
        </div>
      </div>

      {/* ── Stats Grid ──────────────────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.title} href={s.href} className="group block">
            <Card className="transition-all duration-200 hover:shadow-[0_4px_12px_rgba(0,0,0,0.1),0_12px_32px_rgba(0,0,0,0.06)] hover:-translate-y-1 hover:border-primary/50 cursor-pointer">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm font-medium text-muted-foreground">
                    {s.title}
                  </span>
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shadow-sm ${statIconStyle[s.title] ?? "bg-primary/10 text-primary"}`}
                  >
                    <s.icon className="h-[18px] w-[18px]" />
                  </div>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-3xl font-bold tabular-nums">{s.value}</span>
                  <span className="text-xs text-primary font-medium flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    View <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* ── Quick Actions ────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Quick Actions
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {quickActions.map((action) => (
            <Link key={action.title} href={action.href} className="group block">
              <Card className="transition-all duration-200 hover:shadow-[0_4px_12px_rgba(0,0,0,0.1),0_12px_32px_rgba(0,0,0,0.06)] hover:-translate-y-1 hover:border-primary/50 cursor-pointer h-full relative">
                {action.attention && (
                  <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-amber-400" />
                )}
                <CardContent className="p-5">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${action.iconStyle}`}
                  >
                    <action.icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-medium text-sm mb-1 group-hover:text-primary transition-colors">
                    {action.title}
                  </h3>
                  <p className="text-xs text-muted-foreground">{action.description}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* ── Activity Feed + Registration Link ──────────────────────────────── */}
      {!isRestricted && (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            {event.slug && (
              <CopyLinkCard
                label="Public Registration Link"
                description="Share this link with attendees so they can register for your event."
                slug={event.slug}
                path="register"
              />
            )}
            {/* Registrations by Pricing Tier — finance-reporting tile. Only
                rendered when at least one tier-tagged registration exists,
                so events without pricing tiers don't see a confusing empty
                card. Groups by tier NAME across all ticket types so
                "Early Bird = 87" reflects the union of Physician + Student
                + Allied Health rows. */}
            {tierBreakdown.length > 0 && (
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300 flex items-center justify-center">
                        <TrendingUp className="h-4 w-4" />
                      </div>
                      <h3 className="font-medium text-sm">Registrations by Tier</h3>
                    </div>
                    <Link
                      href={`/events/${eventId}/registrations`}
                      className="text-xs text-primary font-medium flex items-center gap-0.5 hover:underline"
                    >
                      View all <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                  <div className="space-y-2.5">
                    {(() => {
                      const total = tierBreakdown.reduce((s, t) => s + t.count, 0);
                      return tierBreakdown.map((t) => {
                        const pct = total > 0 ? Math.round((t.count / total) * 100) : 0;
                        return (
                          <div key={t.name} className="space-y-1">
                            <div className="flex items-center justify-between text-sm">
                              <span className="font-medium">{t.name}</span>
                              <span className="tabular-nums text-muted-foreground">
                                {t.count} <span className="text-xs">({pct}%)</span>
                              </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-amber-100 overflow-hidden">
                              <div
                                className="h-full bg-amber-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                  <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
                    Excludes cancelled registrations and rows without a pricing tier.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
          <Card>
            <CardContent className="p-5">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
                Recent Activity
              </h3>
              <div className="max-h-[400px] overflow-y-auto">
                <ActivityFeed eventId={eventId} />
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
