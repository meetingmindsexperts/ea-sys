"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  MapPin,
  Users,
  Mic2,
  ArrowRight,
  Search,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { formatDateRange } from "@/lib/utils";
import type { EventSortField, EventSortOrder } from "@/lib/event-sort";

const ITEMS_PER_PAGE = 10;

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
  { label: string; dotCls: string; pillCls: string }
> = {
  DRAFT: {
    label: "Draft",
    dotCls: "bg-gray-400",
    pillCls: "bg-gray-100 text-gray-600 border-gray-200",
  },
  PUBLISHED: {
    label: "Published",
    dotCls: "bg-primary",
    pillCls: "bg-blue-50 text-blue-700 border-blue-200",
  },
  LIVE: {
    label: "Live",
    dotCls: "bg-green-500",
    pillCls: "bg-green-50 text-green-700 border-green-200",
  },
  COMPLETED: {
    label: "Completed",
    dotCls: "bg-purple-500",
    pillCls: "bg-purple-50 text-purple-700 border-purple-200",
  },
  CANCELLED: {
    label: "Cancelled",
    dotCls: "bg-red-400",
    pillCls: "bg-red-50 text-red-600 border-red-200",
  },
};

const filterStatuses = [
  "ALL",
  "DRAFT",
  "PUBLISHED",
  "LIVE",
  "COMPLETED",
  "CANCELLED",
] as const;

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
  sortField: EventSortField;
  sortOrder: EventSortOrder;
}

/** Extract the year from startDate in Dubai timezone (UTC+4) */
function getEventYear(date: string | Date): number {
  const d = new Date(new Date(date).getTime() + 4 * 60 * 60 * 1000);
  return d.getUTCFullYear();
}

function SortIndicator({
  field,
  active,
  order,
}: {
  field: EventSortField;
  active: EventSortField;
  order: EventSortOrder;
}) {
  if (active !== field) {
    return <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />;
  }
  return order === "asc" ? (
    <ArrowUp className="h-3 w-3" aria-hidden="true" />
  ) : (
    <ArrowDown className="h-3 w-3" aria-hidden="true" />
  );
}

export function EventListClient({
  events,
  isRestricted,
  sortField,
  sortOrder,
}: EventListClientProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [yearFilter, setYearFilter] = useState<string>("ALL");
  const [currentPage, setCurrentPage] = useState(1);

  /** Build the URL for a sortable column header: clicking toggles order if
   *  the column is already active, otherwise switches to that column with
   *  descending as the default. */
  const sortHref = (field: EventSortField) => {
    const nextOrder: EventSortOrder =
      sortField === field && sortOrder === "desc" ? "asc" : "desc";
    return `/events?sort=${field}&order=${nextOrder}`;
  };

  // Compute available years from event data
  const availableYears = useMemo(() => {
    const years = new Set<number>();
    for (const event of events) {
      years.add(getEventYear(event.startDate));
    }
    return Array.from(years).sort((a, b) => b - a); // newest first
  }, [events]);

  const filtered = events.filter((event) => {
    const matchesSearch = event.name
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === "ALL" || event.status === statusFilter;
    const matchesYear =
      yearFilter === "ALL" ||
      getEventYear(event.startDate) === parseInt(yearFilter);
    return matchesSearch && matchesStatus && matchesYear;
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedEvents = filtered.slice(
    (safePage - 1) * ITEMS_PER_PAGE,
    safePage * ITEMS_PER_PAGE
  );

  // Reset to page 1 when filters change
  const handleFilterChange = (setter: (v: string) => void, value: string) => {
    setter(value);
    setCurrentPage(1);
  };

  // Count events per status for filter badges
  const statusCounts: Record<string, number> = { ALL: events.length };
  for (const event of events) {
    statusCounts[event.status] = (statusCounts[event.status] || 0) + 1;
  }

  return (
    <div className="space-y-4">
      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9 shadow-sm"
            />
          </div>

          {/* Year filter — always visible */}
          <div className="relative">
            <select
              value={yearFilter}
              onChange={(e) => handleFilterChange(setYearFilter, e.target.value)}
              className="h-9 appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer"
            >
              <option value="ALL">All years</option>
              {availableYears.map((year) => (
                <option key={year} value={year.toString()}>
                  {year}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          </div>
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
                  className="h-7 text-xs px-2.5 shadow-sm"
                  onClick={() => handleFilterChange(setStatusFilter, status)}
                >
                  {filterLabels[status]}
                  <span
                    className={`ml-1.5 ${isActive ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                  >
                    {count}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Event Table ───────────────────────────────────────────────────── */}
      {filtered.length > 0 ? (
        <div className="rounded-xl border bg-card overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.06),0_16px_48px_rgba(0,0,0,0.03)]">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50 shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)]">
                <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">
                  <Link
                    href={sortHref("name")}
                    scroll={false}
                    className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                    aria-sort={sortField === "name" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
                  >
                    Event
                    <SortIndicator field="name" active={sortField} order={sortOrder} />
                  </Link>
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3 hidden md:table-cell">
                  <Link
                    href={sortHref("startDate")}
                    scroll={false}
                    className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
                    aria-sort={sortField === "startDate" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
                  >
                    Date
                    <SortIndicator field="startDate" active={sortField} order={sortOrder} />
                  </Link>
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3 hidden lg:table-cell">
                  Venue
                </th>
                <th className="text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                  Registrations
                </th>
                <th className="text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3 hidden sm:table-cell">
                  Speakers
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">
                  Status
                </th>
                <th className="w-10 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {paginatedEvents.map((event) => {
                const sc = statusConfig[event.status] ?? statusConfig.DRAFT;
                return (
                  <tr
                    key={event.id}
                    className="group transition-all duration-150 hover:bg-primary/[0.03] hover:shadow-[inset_3px_0_0_hsl(var(--primary))]"
                  >
                    {/* Event name + mobile meta */}
                    <td className="px-4 py-3.5">
                      <Link
                        href={isRestricted ? `/events/${event.id}/abstracts` : `/events/${event.id}`}
                        className="block group-hover:text-primary transition-colors"
                      >
                        <span className="font-medium text-sm leading-snug line-clamp-1">
                          {event.name}
                        </span>
                        {/* Show date + venue inline on mobile */}
                        <span className="md:hidden text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                          <Calendar className="h-3 w-3 shrink-0" />
                          {formatDateRange(event.startDate, event.endDate)}
                        </span>
                      </Link>
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3.5 hidden md:table-cell">
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Calendar className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                        <span className="whitespace-nowrap">
                          {formatDateRange(event.startDate, event.endDate)}
                        </span>
                      </div>
                    </td>

                    {/* Venue */}
                    <td className="px-4 py-3.5 hidden lg:table-cell">
                      {event.venue ? (
                        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                          <span className="truncate max-w-[200px]">
                            {event.venue}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">
                          —
                        </span>
                      )}
                    </td>

                    {/* Registrations */}
                    <td className="px-4 py-3.5 text-center hidden sm:table-cell">
                      <div className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        <Users className="h-3.5 w-3.5" />
                        <span>{event._count.registrations}</span>
                      </div>
                    </td>

                    {/* Speakers */}
                    <td className="px-4 py-3.5 text-center hidden sm:table-cell">
                      <div className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        <Mic2 className="h-3.5 w-3.5" />
                        <span>{event._count.speakers}</span>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border shadow-sm ${sc.pillCls}`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${sc.dotCls}`}
                        />
                        {sc.label}
                      </span>
                    </td>

                    {/* Arrow */}
                    <td className="px-4 py-3.5">
                      <Link
                        href={isRestricted ? `/events/${event.id}/abstracts` : `/events/${event.id}`}
                        className="text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                        tabIndex={-1}
                        aria-hidden
                      >
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* ── Pagination ──────────────────────────────────────────────────── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Showing{" "}
                <span className="font-medium text-foreground">
                  {(safePage - 1) * ITEMS_PER_PAGE + 1}
                </span>
                {" - "}
                <span className="font-medium text-foreground">
                  {Math.min(safePage * ITEMS_PER_PAGE, filtered.length)}
                </span>
                {" of "}
                <span className="font-medium text-foreground">
                  {filtered.length}
                </span>{" "}
                events
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0 shadow-sm"
                  disabled={safePage <= 1}
                  onClick={() => setCurrentPage(safePage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                  (page) => (
                    <Button
                      key={page}
                      variant={page === safePage ? "default" : "outline"}
                      size="sm"
                      className="h-8 w-8 p-0 text-xs shadow-sm"
                      onClick={() => setCurrentPage(page)}
                    >
                      {page}
                    </Button>
                  )
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0 shadow-sm"
                  disabled={safePage >= totalPages}
                  onClick={() => setCurrentPage(safePage + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-xl border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.06)]">
          <Search className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <h3 className="text-sm font-medium mb-1">
            No events match your filters
          </h3>
          <p className="text-muted-foreground text-xs max-w-xs">
            Try a different search term or adjust the year/status filters.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 text-xs"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("ALL");
              setYearFilter("ALL");
              setCurrentPage(1);
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
