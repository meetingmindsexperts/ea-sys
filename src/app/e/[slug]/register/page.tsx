"use client";

import { EventBannerBand } from "@/components/public/event-banner";
import { PublicEventNotice } from "@/components/public/event-notice";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import { sanitizeHtml } from "@/lib/sanitize";
import { mainRegisterTarget } from "@/lib/public-availability";
import { useSession } from "next-auth/react";
import {
  Calendar,
  MapPin,
  Loader2,
  AlertCircle,
  Users,
  Copy,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { canEverywhere, principalFromUser } from "@/lib/permissions/can";
import type { RegistrationClosedReason } from "@/lib/registration-closure";

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

interface PricingTier {
  id: string;
  name: string;
  price: string;
  currency: string;
  available: number;
  soldOut: boolean;
  canPurchase: boolean;
  /** The tier's position on the Registration Types page; orders the main link. */
  sortOrder?: number | null;
}

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  category: string;
  price: string;
  currency: string;
  available: number;
  soldOut: boolean;
  canPurchase: boolean;
  pricingTiers?: PricingTier[];
}

interface Event {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startDate: string;
  endDate: string;
  timezone: string;
  venue: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  bannerImage: string | null;
  bannerImageMobile?: string | null;
  footerHtml: string | null;
  registrationOpen?: boolean;
  /** Why it is closed (registration-closure.ts), for the wording; null when open. */
  registrationClosedReason?: RegistrationClosedReason | null;
  /** Tier-name slugs the main link may land on, in order (Settings → Registration). */
  mainRegisterTiers?: string[];
  /** Sponsor-link rates (code-required-tiers.ts): the main link never lands on one. */
  codeRequiredTiers?: string[];
  eventType?: string | null;
  /** Event-wide attendee cap reached (Settings → Maximum Attendees). */
  eventFull?: boolean;
  organization: { name: string; logo: string | null };
  ticketTypes: TicketType[];
}

interface TierGroup {
  tierName: string;
  slug: string;
  regTypes: { name: string; price: number; currency: string; canPurchase: boolean }[];
  minPrice: number;
  maxPrice: number;
  currency: string;
  allFree: boolean;
  availableCount: number;
}

function groupPriceLabel(group: TierGroup): string {
  if (group.allFree) return "Free";
  if (group.minPrice === group.maxPrice) return `${group.currency} ${group.minPrice}`;
  return `${group.currency} ${group.minPrice} – ${group.maxPrice}`;
}

function regTypePriceLabel(rt: TierGroup["regTypes"][number]): string {
  if (!rt.canPurchase) return "Closed";
  return rt.price === 0 ? "Free" : `${rt.currency} ${rt.price}`;
}

/**
 * The rate the main /register link sends a visitor to, or undefined when it
 * should show the closed page instead.
 */
function mainLinkTarget(event: Event) {
  // Master switch (Settings → Registration). When OFF, registration is closed
  // regardless of which individual tiers (standard/onsite) are active — so we
  // skip the redirect and show the branded closed page.
  // The shared rule (public-availability.ts), so the public event page that
  // links here can never say "Register" when this page would say closed.
  // Event-wide cap: blocks like closed EXCEPT on HYBRID events, where virtual
  // attendance (uncapped) is still open, so we redirect to the tier page which
  // shows the in-person-full notice. Only ticked tier names are candidates.
  return mainRegisterTarget({
    registrationOpen: event.registrationOpen !== false,
    eventFull: event.eventFull === true,
    eventType: event.eventType,
    ticketTypes: event.ticketTypes,
    mainRegisterTiers: event.mainRegisterTiers,
    codeRequiredTiers: event.codeRequiredTiers,
  });
}

/** What staff see above the links while the public form is closed (registration-closure.ts). */
function organiserClosedNote(reason: RegistrationClosedReason | null): string {
  return `Public registration is closed: ${closedWhy(reason)}. These links show attendees a closed page; you can still add registrations from the dashboard.`;
}

function closedWhy(reason: RegistrationClosedReason | null): string {
  if (reason === "webinar-over") return "the webinar is over";
  if (reason === "closing-date-passed") return "its close date in Settings, Registration has passed";
  return "Registration Open is off in Settings, Registration";
}

/** The closed page's line: a webinar that is over, a full event, or closed. */
function closedNoticeText(name: string, why: { webinarOver: boolean; full: boolean }): string {
  if (why.webinarOver) return `${name} has ended, so registration is closed. Please contact the organizer for more information.`;
  if (why.full) return `${name} has reached its maximum number of attendees. Please contact the organizer for more information.`;
  return `Registration is not currently open for ${name}. Please contact the organizer for more information.`;
}

export default function RegisterOverviewPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const { data: session, status: sessionStatus } = useSession();

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Staff preview of a draft event: whoever may edit every event (was canWrite).
  const isAuthorized = !!session?.user && canEverywhere(principalFromUser(session.user), "events.update");

  useEffect(() => {
    async function fetchEvent() {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) {
          setError(res.status === 404 ? "Event not found" : "Failed to load event");
          return;
        }
        setEvent(await res.json());
      } catch (err) {
        console.error("[register] Failed to load event:", err);
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }
    if (slug) fetchEvent();
  }, [slug]);

  // A visitor (not staff previewing) on the main link goes straight to the rate.
  const activeTier = !isAuthorized && event ? mainLinkTarget(event) : undefined;
  const redirectTo = activeTier ? `/e/${slug}/register/${toSlug(activeTier.name)}` : null;
  useEffect(() => {
    if (!redirectTo || sessionStatus === "loading") return;
    // Keep the query string: a sponsor's link carries `?promo=CODE` (and
    // UTM tags), and the rate page applies it (Sep 29, 2026).
    router.replace(`${redirectTo}${window.location.search}`);
  }, [redirectTo, sessionStatus, router]);

  const copyLink = (tierSlug: string) => {
    const url = `${window.location.origin}/e/${slug}/register/${tierSlug}`;
    navigator.clipboard.writeText(url);
    setCopiedSlug(tierSlug);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  if (loading || sessionStatus === "loading") {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    );
  }

  // Not logged in or not admin/organizer with no event → show error
  if (!isAuthorized && !event) {
    return (
      <PublicEventNotice
        tone="error"
        missingEvent={!error || error === "Event not found"}
        title={error || "Event not found"}
        description="Please check the link and try again."
      />
    );
  }

  // Not logged in or not admin/organizer → auto-redirect to first active non-presenter tier
  if (!isAuthorized && event) {
    // The redirect itself runs in the effect above; navigating during
    // render is a React error ("Cannot update a component while rendering").
    if (activeTier) {
      return (
        <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        </div>
      );
    }

    // Why it is closed (the same two tests as mainLinkTarget), for the wording.
    const registrationOpen = event.registrationOpen !== false;
    const eventFullBlocks = event.eventFull === true && event.eventType !== "HYBRID";

    // No active DELEGATE tiers (every tier: early-bird / standard /
    // onsite — closed) → branded "Registration Closed" page.
    const webinarOver = event.registrationClosedReason === "webinar-over";
    const closedTitle = eventFullBlocks && registrationOpen ? "Registration Full" : "Registration Closed";
    return (
      <PublicEventNotice
        event={event}
        title={webinarOver ? "This webinar has ended" : closedTitle}
        description={closedNoticeText(event.name, { webinarOver, full: eventFullBlocks && registrationOpen })}
      >
        {/* Disabled CTA: always reads as closed (or full), whichever tiers
            (standard / onsite / early-bird) are toggled. */}
        <Button type="button" disabled aria-disabled className="w-full rounded-lg font-semibold py-3 text-base">
          {closedTitle}
        </Button>
      </PublicEventNotice>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <PublicEventNotice
        tone="error"
        missingEvent={!error || error === "Event not found"}
        title={error || "Event not found"}
        description="Please check the link and try again."
      />
    );
  }

  const tierGroups = buildTierGroups(event.ticketTypes);
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]">
      {/* Banner */}
      {event.bannerImage ? (
        <EventBannerBand banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} />
      ) : (
        <div className="bg-white border-b border-slate-100">
          <div className="h-1 bg-gradient-primary" />
        </div>
      )}

      {/* Event Info Strip */}
      <div className="bg-white border-b border-slate-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
            <h2 className="text-base font-semibold text-slate-800 mr-auto">{event.name}</h2>
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <Calendar className="h-3.5 w-3.5 text-primary/70" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 text-sm text-slate-500">
                <MapPin className="h-3.5 w-3.5 text-primary/70" />
                <span>{locationParts.join(", ")}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 max-w-5xl mx-auto w-full px-4 sm:px-6 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="h-5 w-5 rounded bg-amber-100 flex items-center justify-center">
              <Eye className="h-3 w-3 text-amber-600" />
            </div>
            <span className="text-xs font-semibold text-amber-700 uppercase tracking-wider">Organizer View</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Registration Form Links</h1>
          <p className="text-slate-500 text-sm mt-1">
            Copy and share these links with attendees. Each link opens a separate registration form.
          </p>
          {event && event.registrationOpen === false ? (
            <p role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {organiserClosedNote(event.registrationClosedReason ?? null)}
            </p>
          ) : null}
        </div>

        {tierGroups.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center">
            <AlertCircle className="h-10 w-10 text-slate-300 mx-auto mb-4" />
            <p className="font-medium text-slate-700">No registration forms configured</p>
            <p className="text-sm text-slate-400 mt-1">Add pricing tiers to your registration types in the dashboard.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {tierGroups.map((group) => {
              const isClosed = group.availableCount === 0;
              const formUrl = `/e/${slug}/register/${group.slug}`;
              const isCopied = copiedSlug === group.slug;

              return (
                <div
                  key={group.tierName}
                  className={cn(
                    "bg-white rounded-2xl border shadow-sm overflow-hidden",
                    isClosed ? "border-slate-200 opacity-70" : "border-slate-200"
                  )}
                >
                  <div className="p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-bold text-slate-900">{group.tierName}</h3>
                        {isClosed ? (
                          <span className="flex items-center gap-1 text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                            <EyeOff className="h-3 w-3" /> Closed
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                            <Eye className="h-3 w-3" /> Active
                          </span>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-slate-900">
                          {groupPriceLabel(group)}
                        </p>
                      </div>
                    </div>

                    {/* Pricing table. When the whole group is free, the
                         group-level "Free" badge already communicates price —
                         we only show the per-row price column if at least
                         one row has a non-zero price (or is closed). */}
                    {group.regTypes.length > 0 && (
                      <div className="grid gap-1.5 mb-4">
                        {group.regTypes.map((rt) => (
                          <div key={rt.name} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-slate-50/80">
                            <div className="flex items-center gap-2">
                              <Users className="h-3.5 w-3.5 text-slate-400" />
                              <span className={cn("text-sm font-medium", rt.canPurchase ? "text-slate-700" : "text-slate-400 line-through")}>{rt.name}</span>
                            </div>
                            {(!group.allFree || !rt.canPurchase) && (
                              <span className={cn("text-sm font-semibold", rt.canPurchase ? "text-slate-900" : "text-slate-400")}>
                                {regTypePriceLabel(rt)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Shareable URL */}
                    <div className="flex items-center gap-2 bg-slate-50 rounded-lg border border-slate-200 p-2">
                      <code className="flex-1 text-xs text-slate-500 truncate pl-2">{formUrl}</code>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        onClick={() => copyLink(group.slug)}
                      >
                        {isCopied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                        {isCopied ? "Copied" : "Copy"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        asChild
                      >
                        <a href={formUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3 w-3 mr-1" /> Open
                        </a>
                      </Button>
                      {/* Staff attending themselves: the form uses their signed-in account. */}
                      <Button size="sm" className="h-7 text-xs shrink-0" asChild>
                        <a href={`${formUrl}?self=1`}>Register myself</a>
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Instructions */}
        <div className="mt-8 bg-slate-50 rounded-xl border border-slate-200 p-5">
          <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">How it works</h3>
          <ol className="space-y-2.5 text-sm text-slate-600">
            <li className="flex gap-2.5">
              <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">1</span>
              <span>Copy a registration link and share it with attendees via email, website, or social media. Each link opens a separate form.</span>
            </li>
            <li className="flex gap-2.5">
              <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">2</span>
              <span>To close a form (e.g., when Early Bird period ends), go to <strong>Registration Types</strong> in the dashboard and toggle the pricing tier to <strong>Inactive</strong>. The public link will show &quot;Registration closed&quot;.</span>
            </li>
            <li className="flex gap-2.5">
              <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">3</span>
              <span>You can hide specific registration types (e.g., Student) from all forms by toggling the registration type itself to Inactive in the dashboard.</span>
            </li>
          </ol>
        </div>
      </div>

      {/* Footer */}
      {event?.footerHtml && (
        <div className="w-full border-t border-slate-200/60 bg-white text-center py-6">
          {/* Footer content constrained to the BODY's width (max-w-5xl). */}
          <div className="prose prose-slate max-w-5xl mx-auto px-4 sm:px-6 [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }} />
        </div>
      )}
    </div>
  );
}

function buildTierGroups(ticketTypes: TicketType[]): TierGroup[] {
  const hasPricingTiers = ticketTypes.some((tt) => tt.pricingTiers && tt.pricingTiers.length > 0);

  if (hasPricingTiers) {
    const tierMap = new Map<string, TierGroup["regTypes"]>();
    const tierOrder: string[] = [];
    for (const tt of ticketTypes) {
      for (const tier of tt.pricingTiers ?? []) {
        if (!tierMap.has(tier.name)) { tierMap.set(tier.name, []); tierOrder.push(tier.name); }
        tierMap.get(tier.name)!.push({
          name: tt.name, price: Number(tier.price), currency: tier.currency, canPurchase: tier.canPurchase,
        });
      }
    }
    return tierOrder.map((tierName) => {
      const regTypes = tierMap.get(tierName)!;
      const purchasable = regTypes.filter((rt) => rt.canPurchase);
      const prices = purchasable.map((rt) => rt.price);
      return {
        tierName, slug: toSlug(tierName), regTypes,
        minPrice: prices.length > 0 ? Math.min(...prices) : 0,
        maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
        currency: purchasable[0]?.currency ?? "USD",
        allFree: prices.every((p) => p === 0),
        availableCount: purchasable.length,
      };
    });
  }

  // Legacy fallback
  const catMap = new Map<string, TicketType[]>();
  const catOrder: string[] = [];
  for (const tt of ticketTypes) {
    const cat = tt.category || "Standard";
    if (!catMap.has(cat)) { catMap.set(cat, []); catOrder.push(cat); }
    catMap.get(cat)!.push(tt);
  }
  return catOrder.map((cat) => {
    const tickets = catMap.get(cat)!;
    const purchasable = tickets.filter((t) => t.canPurchase);
    const prices = purchasable.map((t) => Number(t.price));
    return {
      tierName: cat, slug: toSlug(cat),
      regTypes: tickets.map((t) => ({ name: t.name, price: Number(t.price), currency: t.currency, canPurchase: t.canPurchase })),
      minPrice: prices.length > 0 ? Math.min(...prices) : 0,
      maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
      currency: purchasable[0]?.currency ?? "USD",
      allFree: prices.every((p) => p === 0),
      availableCount: purchasable.length,
    };
  });
}
