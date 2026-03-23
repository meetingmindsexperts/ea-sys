"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { format } from "date-fns";
import Link from "next/link";
import { sanitizeHtml } from "@/lib/sanitize";
import {
  Calendar,
  MapPin,
  Clock,
  Loader2,
  FileText,
  ChevronRight,
  AlertCircle,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  footerHtml: string | null;
  organization: { name: string; logo: string | null };
  ticketTypes: TicketType[];
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
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

export default function PublicEventRegisterPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!event) return;
    const groups = buildTierGroups(event.ticketTypes);
    const available = groups.filter((g) => g.availableCount > 0);
    if (available.length === 1) {
      router.replace(`/e/${slug}/register/${available[0].slug}`);
    }
  }, [event, slug, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-slate-400 text-sm">Loading event…</p>
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Event not found"}</h2>
          <p className="text-slate-500 text-sm">Please check the link and try again.</p>
        </div>
      </div>
    );
  }

  const tierGroups = buildTierGroups(event.ticketTypes);
  const hasAvailable = tierGroups.some((g) => g.availableCount > 0);
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]">
      {/* Banner */}
      {event.bannerImage ? (
        <div className="relative w-full bg-white">
          <div className="max-w-[1400px] mx-auto">
            <Image src={event.bannerImage} alt={event.name} width={1400} height={400}
              className="w-full h-auto max-h-[260px] object-contain" priority unoptimized />
          </div>
        </div>
      ) : (
        <div className="bg-white border-b border-slate-100">
          <div className="h-1 bg-gradient-primary" />
        </div>
      )}

      {/* Event Info Strip */}
      <div className="bg-white border-b border-slate-200/60 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
            <h2 className="text-base font-semibold text-slate-800 mr-auto">{event.name}</h2>
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <Calendar className="h-3.5 w-3.5 text-primary/70" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-1.5 text-sm text-slate-500">
              <Clock className="h-3.5 w-3.5 text-primary/70" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
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

      {/* Main — single centered column */}
      <div className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 py-8">
        {/* Heading */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Choose Your Registration</h1>
          <p className="text-slate-500 text-sm mt-1">Select a registration period to view available types and pricing</p>
        </div>

        {!hasAvailable ? (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center">
            <AlertCircle className="h-10 w-10 text-slate-300 mx-auto mb-4" />
            <p className="font-medium text-slate-700">Registration is currently closed</p>
            <p className="text-sm text-slate-400 mt-1">Check back later or contact the organizer.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {tierGroups.map((group) => {
              const isClosed = group.availableCount === 0;
              const purchasable = group.regTypes.filter((rt) => rt.canPurchase);

              return (
                <Link
                  key={group.tierName}
                  href={isClosed ? "#" : `/e/${slug}/register/${group.slug}`}
                  className={cn(
                    "block bg-white rounded-2xl border shadow-sm transition-all duration-200 overflow-hidden",
                    isClosed
                      ? "opacity-50 cursor-not-allowed border-slate-200"
                      : "border-slate-200 hover:border-primary/40 hover:shadow-md"
                  )}
                  onClick={(e) => isClosed && e.preventDefault()}
                >
                  {/* Top accent bar */}
                  {!isClosed && <div className="h-1 bg-gradient-to-r from-primary via-primary/70 to-primary/30" />}

                  <div className="p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-bold text-slate-900">{group.tierName}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {isClosed ? "Registration closed" : `${purchasable.length} registration type${purchasable.length !== 1 ? "s" : ""} available`}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-lg font-bold text-slate-900">
                            {isClosed ? "Closed"
                              : group.allFree ? "Free"
                              : group.minPrice === group.maxPrice
                              ? `${group.currency} ${group.minPrice}`
                              : `${group.currency} ${group.minPrice} – ${group.maxPrice}`}
                          </p>
                          {!isClosed && !group.allFree && group.minPrice !== group.maxPrice && (
                            <p className="text-[11px] text-slate-400">depending on type</p>
                          )}
                        </div>
                        {!isClosed && (
                          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <ChevronRight className="h-5 w-5 text-primary" />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Pricing table */}
                    {!isClosed && purchasable.length > 0 && (
                      <div className="border-t border-slate-100 pt-4">
                        <div className="grid gap-2">
                          {purchasable.map((rt) => (
                            <div key={rt.name} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-slate-50/80">
                              <div className="flex items-center gap-2">
                                <Users className="h-3.5 w-3.5 text-slate-400" />
                                <span className="text-sm font-medium text-slate-700">{rt.name}</span>
                              </div>
                              <span className="text-sm font-semibold text-slate-900">
                                {rt.price === 0 ? "Free" : `${rt.currency} ${rt.price}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {/* Quick links */}
        <div className="grid sm:grid-cols-2 gap-3 mt-8">
          <Link href={`/e/${slug}/schedule`} className="block group">
            <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                  <Calendar className="h-4 w-4 text-amber-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 text-sm">View Programme</p>
                  <p className="text-xs text-slate-400">Full agenda &amp; schedule</p>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary shrink-0" />
              </div>
            </div>
          </Link>
          {event.abstractSettings?.allowAbstractSubmissions && (
            <Link href={`/e/${slug}/submitAbstract`} className="block group">
              <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:border-primary/40 hover:shadow-md transition-all">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <FileText className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-800 text-sm">Call for Abstracts</p>
                    <p className="text-xs text-slate-400">
                      {event.abstractSettings.abstractDeadline
                        ? `Deadline: ${format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}`
                        : "Submit your abstract"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-primary shrink-0" />
                </div>
              </div>
            </Link>
          )}
        </div>

        {/* Event description */}
        {event.description && (
          <div className="mt-6 bg-white rounded-xl border border-slate-200/80 shadow-sm p-6">
            <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-2">About This Event</h3>
            <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap line-clamp-6">{event.description}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      {event.footerHtml && (
        <div className="w-full border-t border-slate-200/60 bg-white text-center p-4 text-xs text-slate-500"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }} />
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
