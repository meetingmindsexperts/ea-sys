"use client";

/**
 * The frame every shared view shares: banner, heading with the live marker,
 * print, a toolbar strip and the organisation footer.
 */
import type { ReactNode } from "react";
import { Calendar, Printer, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { EventBannerBand } from "@/components/public/event-banner";
import { formatEventDateRange, resolveTimezone } from "@/lib/event-time";
import type { SharedEventBranding } from "./types";

export function SharedShell({
  event,
  eyebrow,
  generatedAt,
  toolbar,
  wide = false,
  children,
}: {
  event: SharedEventBranding;
  eyebrow: string;
  generatedAt: string;
  toolbar: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const width = wide ? "max-w-6xl" : "max-w-4xl";
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 print:bg-white">
      <EventBannerBand banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} className="print:hidden" />

      <div className="bg-white border-b border-slate-100">
        <div className={cn(width, "mx-auto px-4 sm:px-6 py-6")}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-1">{eyebrow}</p>
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 text-balance">{event.name}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatEventDateRange(new Date(event.startDate), new Date(event.endDate), resolveTimezone(event.timezone))}
                </span>
                <span className="inline-flex items-center gap-1.5 print:hidden">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Live, updated {new Date(generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              aria-label="Print or save as PDF"
              title="Print / Save PDF"
              className="shrink-0 flex items-center justify-center sm:gap-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-sm font-medium h-10 w-10 sm:h-auto sm:w-auto sm:px-4 sm:py-2 rounded-xl shadow-sm transition-colors print:hidden"
            >
              <Printer className="h-4 w-4" />
              <span className="hidden sm:inline">Print / Save PDF</span>
            </button>
          </div>
        </div>
      </div>

      <div className="bg-slate-100/70 border-b border-slate-200 print:hidden">
        <div className={cn(width, "mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row gap-2 sm:items-center")}>{toolbar}</div>
      </div>

      <main className={cn("flex-1 w-full mx-auto px-4 sm:px-6 py-6 space-y-4", width)}>{children}</main>

      <footer className="py-6 text-center text-xs text-slate-400 print:hidden">{event.organizationName}</footer>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative flex-1">
      <span className="sr-only">Search</span>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
    </label>
  );
}

export function FilterSelect({ value, onChange, label, allLabel, options }: { value: string; onChange: (v: string) => void; label: string; allLabel: string; options: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm sm:w-64 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <option value="all">{allLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

export function TruncatedNote({ count, noun }: { count: number; noun: string }) {
  return (
    <p className="rounded-lg bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-800">
      Showing the first {count} {noun}. Ask the organiser for the full list.
    </p>
  );
}
