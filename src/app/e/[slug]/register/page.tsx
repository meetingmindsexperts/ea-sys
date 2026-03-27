"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { format } from "date-fns";
import { sanitizeHtml } from "@/lib/sanitize";
import { useSession } from "next-auth/react";
import {
  Calendar,
  MapPin,
  Clock,
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

export default function RegisterOverviewPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const { data: session, status: sessionStatus } = useSession();

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const isAuthorized = session?.user?.role === "SUPER_ADMIN" || session?.user?.role === "ADMIN" || session?.user?.role === "ORGANIZER";

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
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-900 mb-2">{error || "Event not found"}</h2>
          <p className="text-slate-500 text-sm">Please check the link and try again.</p>
        </div>
      </div>
    );
  }

  // Not logged in or not admin/organizer → auto-redirect to first active non-presenter tier
  if (!isAuthorized && event) {
    // Find first active tier by priority, excluding "Presenter" (presenter has its own direct link)
    const activeTier = event.ticketTypes
      ?.flatMap((tt: TicketType) => (tt.pricingTiers || []).filter((t: PricingTier) => t.canPurchase))
      .filter((t: PricingTier) => toSlug(t.name) !== "presenter")
      .sort((a: PricingTier, b: PricingTier) => {
        const order = ["early-bird", "standard", "onsite"];
        const ai = order.indexOf(toSlug(a.name));
        const bi = order.indexOf(toSlug(b.name));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })[0];

    if (activeTier) {
      router.replace(`/e/${slug}/register/${toSlug(activeTier.name)}`);
      return (
        <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
        </div>
      );
    }

    // No active non-presenter tiers → closed
    return (
      <div className="min-h-screen bg-[#f8f9fb] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-100 p-8 w-full max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-slate-300 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Registration Closed</h2>
          <p className="text-slate-500 text-sm">
            Registration is not currently open for this event. Please contact the organizer for more information.
          </p>
        </div>
      </div>
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
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fb]">
      {/* Banner */}
      {event.bannerImage ? (
        <div className="relative w-full bg-white">
          <div className="max-w-[1400px] mx-auto">
            <Image src={event.bannerImage} alt={event.name} width={1400} height={400}
              className="w-full h-auto max-h-[200px] object-contain" priority unoptimized />
          </div>
        </div>
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
                          {group.allFree ? "Free"
                            : group.minPrice === group.maxPrice
                            ? `${group.currency} ${group.minPrice}`
                            : `${group.currency} ${group.minPrice} – ${group.maxPrice}`}
                        </p>
                      </div>
                    </div>

                    {/* Pricing table */}
                    {group.regTypes.length > 0 && (
                      <div className="grid gap-1.5 mb-4">
                        {group.regTypes.map((rt) => (
                          <div key={rt.name} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-slate-50/80">
                            <div className="flex items-center gap-2">
                              <Users className="h-3.5 w-3.5 text-slate-400" />
                              <span className={cn("text-sm font-medium", rt.canPurchase ? "text-slate-700" : "text-slate-400 line-through")}>{rt.name}</span>
                            </div>
                            <span className={cn("text-sm font-semibold", rt.canPurchase ? "text-slate-900" : "text-slate-400")}>
                              {rt.canPurchase ? (rt.price === 0 ? "Free" : `${rt.currency} ${rt.price}`) : "Closed"}
                            </span>
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
        <div className="w-full border-t border-slate-200/60 bg-white text-center px-4 py-6">
          <div className="prose prose-slate max-w-none mx-auto [&>*]:mb-4 [&>*:last-child]:mb-0 [&_a]:text-primary [&_a]:underline"
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
