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
  Ticket,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TicketTypeCategory = "EARLY_BIRD" | "STANDARD" | "PRESENTER" | "OTHER";

const CATEGORY_LABELS: Record<TicketTypeCategory, string> = {
  EARLY_BIRD: "Early Bird",
  STANDARD: "Standard",
  PRESENTER: "Presenter",
  OTHER: "Other",
};

const CATEGORY_DESCRIPTIONS: Record<TicketTypeCategory, string> = {
  EARLY_BIRD: "Discounted rates for early registrants",
  STANDARD: "Standard registration rates",
  PRESENTER: "Special rates for presenters and speakers",
  OTHER: "Additional registration options",
};

const CATEGORY_SLUGS: Record<TicketTypeCategory, string> = {
  EARLY_BIRD: "early-bird",
  STANDARD: "standard",
  PRESENTER: "presenter",
  OTHER: "other",
};

const CATEGORY_ORDER: TicketTypeCategory[] = ["EARLY_BIRD", "STANDARD", "PRESENTER", "OTHER"];

const CATEGORY_COLORS: Record<TicketTypeCategory, string> = {
  EARLY_BIRD: "bg-orange-50 border-orange-200 hover:border-orange-400",
  STANDARD: "bg-blue-50 border-blue-200 hover:border-blue-400",
  PRESENTER: "bg-purple-50 border-purple-200 hover:border-purple-400",
  OTHER: "bg-slate-50 border-slate-200 hover:border-slate-400",
};

const CATEGORY_ICON_COLORS: Record<TicketTypeCategory, string> = {
  EARLY_BIRD: "bg-orange-100 text-orange-600",
  STANDARD: "bg-blue-100 text-blue-600",
  PRESENTER: "bg-purple-100 text-purple-600",
  OTHER: "bg-slate-100 text-slate-600",
};

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  category: TicketTypeCategory;
  price: string;
  currency: string;
  quantity: number;
  soldCount: number;
  available: number;
  soldOut: boolean;
  canPurchase: boolean;
  salesStarted: boolean;
  salesEnded: boolean;
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
  organization: {
    name: string;
    logo: string | null;
  };
  ticketTypes: TicketType[];
  abstractSettings?: {
    allowAbstractSubmissions: boolean;
    abstractDeadline: string | null;
  };
}

interface CategoryGroup {
  category: TicketTypeCategory;
  label: string;
  slug: string;
  tickets: TicketType[];
  availableCount: number;
  minPrice: number;
  maxPrice: number;
  currency: string;
  allFree: boolean;
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
        const data = await res.json();
        setEvent(data);
      } catch {
        setError("Failed to load event");
      } finally {
        setLoading(false);
      }
    }

    if (slug) {
      fetchEvent();
    }
  }, [slug]);

  useEffect(() => {
    if (!event) return;

    // Build category groups to check for auto-redirect
    const groups = CATEGORY_ORDER
      .map((cat) => {
        const tickets = event.ticketTypes.filter((t) => (t.category || "STANDARD") === cat);
        const available = tickets.filter((t) => t.canPurchase);
        return { category: cat, available };
      })
      .filter((g) => g.available.length > 0);

    // If only one category has available tickets, auto-redirect
    if (groups.length === 1) {
      router.replace(`/e/${slug}/register/${CATEGORY_SLUGS[groups[0].category]}`);
    }
  }, [event, slug, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 rounded-full border-2 border-primary/20" />
            <Loader2 className="h-12 w-12 animate-spin text-primary absolute inset-0" />
          </div>
          <p className="text-slate-400 text-sm tracking-wide">Loading event…</p>
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md text-center">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-red-50 flex items-center justify-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            {error || "Event not found"}
          </h2>
          <p className="text-slate-500 text-sm">
            Please check the link and try again.
          </p>
        </div>
      </div>
    );
  }

  // Build category groups
  const categoryGroups: CategoryGroup[] = CATEGORY_ORDER
    .map((cat) => {
      const tickets = event.ticketTypes.filter((t) => (t.category || "STANDARD") === cat);
      const available = tickets.filter((t) => t.canPurchase);
      const prices = available.map((t) => Number(t.price));
      return {
        category: cat,
        label: CATEGORY_LABELS[cat],
        slug: CATEGORY_SLUGS[cat],
        tickets,
        availableCount: available.length,
        minPrice: prices.length > 0 ? Math.min(...prices) : 0,
        maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
        currency: available[0]?.currency || "USD",
        allFree: prices.every((p) => p === 0),
      };
    })
    .filter((g) => g.tickets.length > 0);

  const hasAvailable = categoryGroups.some((g) => g.availableCount > 0);
  const locationParts = [event.venue, event.city, event.country].filter(Boolean);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Hero Section */}
      <div className="relative bg-slate-900 overflow-hidden">
        {event.bannerImage && (
          <>
            <Image
              src={event.bannerImage}
              alt={event.name}
              width={1400}
              height={500}
              className="w-full h-52 sm:h-72 object-cover opacity-40"
              unoptimized
            />
            <div className="absolute inset-0 bg-gradient-to-b from-slate-900/60 via-slate-900/70 to-slate-900" />
          </>
        )}

        {!event.bannerImage && (
          <div className="absolute inset-0 opacity-5 bg-dot-pattern" />
        )}

        <div
          className={cn(
            "relative max-w-6xl mx-auto px-4 sm:px-6",
            event.bannerImage ? "py-8 -mt-8" : "py-12"
          )}
        >
          <div className="flex items-center gap-2 mb-4">
            {event.organization.logo ? (
              <Image
                src={event.organization.logo}
                alt={event.organization.name}
                width={24}
                height={24}
                className="rounded"
                unoptimized
              />
            ) : null}
            <span className="text-xs font-medium tracking-widest uppercase text-primary/80">
              {event.organization.name}
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-6 leading-tight max-w-3xl">
            {event.name}
          </h1>

          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1.5 text-sm text-white/90">
              <Calendar className="h-3.5 w-3.5 text-primary" />
              <span>{format(new Date(event.startDate), "MMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1.5 text-sm text-white/90">
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span>{format(new Date(event.startDate), "h:mm a")}</span>
            </div>
            {locationParts.length > 0 && (
              <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm border border-white/10 rounded-full px-3 py-1.5 text-sm text-white/90">
                <MapPin className="h-3.5 w-3.5 text-primary" />
                <span>{locationParts.join(", ")}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 flex-1 w-full">
        <div className="grid md:grid-cols-5 gap-8 items-start">
          {/* Left: Info sidebar */}
          <div className="md:col-span-2 space-y-5">
            {event.description && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
                  About This Event
                </h3>
                <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">
                  {event.description}
                </p>
              </div>
            )}

            <Link href={`/e/${slug}/schedule`} className="block group">
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:border-primary/40 hover:shadow-md transition-all duration-200">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
                    <Calendar className="h-5 w-5 text-amber-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 text-sm">View Programme</p>
                    <p className="text-xs text-slate-500 mt-0.5">Full agenda &amp; schedule</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-primary transition-colors shrink-0" />
                </div>
              </div>
            </Link>

            {event.abstractSettings?.allowAbstractSubmissions && (
              <Link href={`/e/${slug}/submitAbstract`} className="block group">
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:border-primary/40 hover:shadow-md transition-all duration-200">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <FileText className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-900 text-sm">Call for Abstracts</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {event.abstractSettings.abstractDeadline
                          ? `Deadline: ${format(new Date(event.abstractSettings.abstractDeadline), "MMM d, yyyy")}`
                          : "Submit your abstract for review"}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-primary transition-colors shrink-0" />
                  </div>
                </div>
              </Link>
            )}
          </div>

          {/* Right: Registration Categories */}
          <div className="md:col-span-3">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-100">
                <h2 className="text-lg font-semibold text-slate-900">
                  Register for This Event
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  Choose your registration category to proceed
                </p>
              </div>

              <div className="p-6">
                {!hasAvailable ? (
                  <div className="text-center py-12">
                    <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center">
                      <AlertCircle className="h-7 w-7 text-slate-400" />
                    </div>
                    <p className="font-medium text-slate-700">
                      Registration is currently closed
                    </p>
                    <p className="text-sm text-slate-400 mt-1">
                      Check back later or contact the organizer.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    {categoryGroups.map((group) => {
                      const isClosed = group.availableCount === 0;

                      return (
                        <Link
                          key={group.category}
                          href={isClosed ? "#" : `/e/${slug}/register/${group.slug}`}
                          className={cn(
                            "block rounded-2xl border-2 p-5 transition-all duration-200",
                            isClosed
                              ? "opacity-50 cursor-not-allowed border-slate-200 bg-slate-50"
                              : cn(CATEGORY_COLORS[group.category], "hover:shadow-md hover:-translate-y-0.5")
                          )}
                          onClick={(e) => isClosed && e.preventDefault()}
                        >
                          <div className="flex items-start gap-4">
                            <div className={cn(
                              "h-11 w-11 rounded-xl flex items-center justify-center shrink-0",
                              CATEGORY_ICON_COLORS[group.category]
                            )}>
                              <Ticket className="h-5 w-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-semibold text-slate-900">
                                    {group.label} Registration
                                  </p>
                                  <p className="text-xs text-slate-500 mt-0.5">
                                    {CATEGORY_DESCRIPTIONS[group.category]}
                                  </p>
                                </div>
                                {!isClosed && (
                                  <ChevronRight className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
                                )}
                              </div>
                              <div className="flex items-center gap-4 mt-3">
                                <span className="text-sm font-bold text-slate-800">
                                  {isClosed
                                    ? "Closed"
                                    : group.allFree
                                    ? "Free"
                                    : group.minPrice === group.maxPrice
                                    ? `${group.currency} ${group.minPrice}`
                                    : `From ${group.currency} ${group.minPrice}`}
                                </span>
                                <span className="text-xs text-slate-400">
                                  {group.availableCount} {group.availableCount === 1 ? "option" : "options"} available
                                </span>
                              </div>
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Custom Footer */}
      {event.footerHtml && (
        <div
          className="w-full border-t bg-white"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(event.footerHtml) }}
        />
      )}
    </div>
  );
}
