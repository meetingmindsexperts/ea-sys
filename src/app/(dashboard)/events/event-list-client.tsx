"use client";

import { useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Users, ArrowRight, Search } from "lucide-react";
import { formatDateRange } from "@/lib/utils";

interface EventListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  startDate: string | Date;
  endDate: string | Date;
  venue: string | null;
  _count: { registrations: number; speakers: number };
}

const statusConfig: Record<
  string,
  { label: string; dotCls: string; pillCls: string; borderCls: string }
> = {
  DRAFT: {
    label: "Draft",
    dotCls: "bg-gray-400",
    pillCls: "bg-gray-100 text-gray-600 border-gray-200",
    borderCls: "border-t-gray-300",
  },
  PUBLISHED: {
    label: "Published",
    dotCls: "bg-primary",
    pillCls: "bg-blue-50 text-blue-700 border-blue-200",
    borderCls: "border-t-primary",
  },
  LIVE: {
    label: "Live",
    dotCls: "bg-green-500",
    pillCls: "bg-green-50 text-green-700 border-green-200",
    borderCls: "border-t-green-500",
  },
  COMPLETED: {
    label: "Completed",
    dotCls: "bg-purple-500",
    pillCls: "bg-purple-50 text-purple-700 border-purple-200",
    borderCls: "border-t-purple-400",
  },
  CANCELLED: {
    label: "Cancelled",
    dotCls: "bg-red-400",
    pillCls: "bg-red-50 text-red-600 border-red-200",
    borderCls: "border-t-red-400",
  },
};

const filterStatuses = ["ALL", "DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"] as const;

const filterLabels: Record<string, string> = {
  ALL: "All",
  DRAFT: "Draft",
  PUBLISHED: "Published",
  LIVE: "Live",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

interface EventListClientProps {
  events: EventListItem[];
  isRestricted: boolean;
}

export function EventListClient({ events, isRestricted }: EventListClientProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  const filtered = events.filter((event) => {
    const matchesSearch = event.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "ALL" || event.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Count events per status for filter badges
  const statusCounts: Record<string, number> = { ALL: events.length };
  for (const event of events) {
    statusCounts[event.status] = (statusCounts[event.status] || 0) + 1;
  }

  return (
    <div className="space-y-4">
      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {!isRestricted && (
          <div className="flex flex-wrap gap-1.5">
            {filterStatuses.map((status) => {
              const count = statusCounts[status] ?? 0;
              if (status !== "ALL" && count === 0) return null;
              const isActive = statusFilter === status;
              return (
                <Button
                  key={status}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs px-2.5"
                  onClick={() => setStatusFilter(status)}
                >
                  {filterLabels[status]}
                  <span className={`ml-1.5 ${isActive ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                    {count}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Event Grid ─────────────────────────────────────────────────────── */}
      {filtered.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((event) => {
            const sc = statusConfig[event.status] ?? statusConfig.DRAFT;
            return (
              <Link key={event.id} href={`/events/${event.id}`} className="group block">
                <div
                  className={`flex flex-col h-full rounded-xl border bg-card overflow-hidden transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/50 border-t-[3px] ${sc.borderCls}`}
                >
                  <div className="flex-1 p-5 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold text-base leading-snug line-clamp-2 group-hover:text-primary transition-colors">
                        {event.name}
                      </h3>
                      <span
                        className={`shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${sc.pillCls}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dotCls}`} />
                        {sc.label}
                      </span>
                    </div>

                    {event.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {event.description}
                      </p>
                    )}

                    <div className="space-y-1.5 text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                        <span>{formatDateRange(event.startDate, event.endDate)}</span>
                      </div>
                      {event.venue && (
                        <div className="flex items-center gap-2">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                          <span className="truncate">{event.venue}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="px-5 py-2.5 border-t bg-muted/20 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      <span>{event._count.registrations} registered</span>
                    </div>
                    <span className="text-xs text-primary font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      Open <ArrowRight className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <h3 className="text-sm font-medium mb-1">No events match your filters</h3>
          <p className="text-muted-foreground text-xs max-w-xs">
            Try a different search term or clear the status filter.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 text-xs"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("ALL");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
