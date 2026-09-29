"use client";

/**
 * Shared submission view (Sep 29, 2026; docs/SUBMISSION_SHARE_PLAN.md): the
 * read-only page behind an organiser's secret link. It shows only what the
 * server returned; the server has already removed every field the organiser
 * did not switch on, so nothing here decides what is private.
 *
 * "Live": it refetches every 60 seconds while the tab is visible, and at once
 * when the viewer comes back to the tab.
 */
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { Calendar, FileText, Link2Off, Loader2, Printer, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { EventBannerBand } from "@/components/public/event-banner";
import { formatEventDateRange, resolveTimezone } from "@/lib/event-time";
import type { SharedItem, ShareKind } from "@/lib/submission-share";

interface SharedPayload {
  event: {
    name: string;
    startDate: string;
    endDate: string;
    timezone: string | null;
    bannerImage: string | null;
    bannerImageMobile: string | null;
    organizationName: string;
  };
  kind: ShareKind;
  fields: string[];
  items: SharedItem[];
  truncated: boolean;
  generatedAt: string;
}

const REFRESH_MS = 60_000;

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  REVISION_REQUESTED: "Revision requested",
};

const STATUS_TONE: Record<string, string> = {
  SUBMITTED: "bg-sky-50 text-sky-700 ring-sky-200",
  UNDER_REVIEW: "bg-amber-50 text-amber-700 ring-amber-200",
  ACCEPTED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  REVISION_REQUESTED: "bg-orange-50 text-orange-700 ring-orange-200",
};

export default function SharedSubmissionsPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("all");

  // React Query owns the polling: every 60 s while the tab is visible (no
  // background polling), and at once when the viewer returns to the tab. A 404
  // is an ANSWER (the link was switched off or replaced), not an error, so it
  // resolves rather than throws and never trips the global error handler.
  const result = useQuery({
    queryKey: ["public-shared", slug, token],
    queryFn: async (): Promise<SharedPayload | "inactive"> => {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/shared/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (res.status === 404) return "inactive";
      if (!res.ok) {
        console.warn("shared-submissions:load-failed", res.status);
        throw new Error(`Load failed (${res.status})`);
      }
      return (await res.json()) as SharedPayload;
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: 1,
  });
  const inactive = result.data === "inactive";
  const data = result.data && result.data !== "inactive" ? result.data : null;
  const loadError = result.isError;

  const has = useCallback((key: string) => data?.fields.includes(key) ?? false, [data]);

  // The theme filter exists only when the theme itself is shown, or its
  // options would reveal a value the organiser chose to hide.
  const themes = useMemo(() => {
    if (!data || !has("theme")) return [];
    return [...new Set(data.items.map((i) => i.theme).filter((t): t is string => !!t))].sort();
  }, [data, has]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.items.filter((i) => {
      if (theme !== "all" && i.theme !== theme) return false;
      if (!q) return true;
      return [i.number, i.title, i.authorName, i.theme, i.authorAffiliation, ...(i.coAuthors ?? [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [data, query, theme]);

  if (inactive) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200 p-10 w-full max-w-md text-center">
          <div className="mx-auto mb-5 h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center">
            <Link2Off className="h-7 w-7 text-slate-400" />
          </div>
          <h1 className="text-lg font-bold text-slate-900 mb-2">This link is no longer active</h1>
          <p className="text-sm text-slate-500">Ask the organiser for a new one.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        {loadError ? (
          <p className="text-sm text-slate-500">This page could not be loaded. It will try again shortly.</p>
        ) : (
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
        )}
      </div>
    );
  }

  const noun = data.kind === "ABSTRACTS" ? "abstract" : "session proposal";
  const heading = data.kind === "ABSTRACTS" ? "Abstracts" : "Session proposals";

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 print:bg-white">
      <EventBannerBand
        banner={data.event.bannerImage}
        bannerMobile={data.event.bannerImageMobile}
        name={data.event.name}
        className="print:hidden"
      />

      <div className="bg-white border-b border-slate-100">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-1">{heading}</p>
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 text-balance">{data.event.name}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {formatEventDateRange(new Date(data.event.startDate), new Date(data.event.endDate), resolveTimezone(data.event.timezone))}
                </span>
                <span className="inline-flex items-center gap-1.5 print:hidden">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Live, updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row gap-2 sm:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search</span>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${heading.toLowerCase()}`}
              className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </label>
          {themes.length > 0 && (
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              aria-label="Filter by theme"
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm sm:w-64 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <option value="all">All themes</option>
              {themes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <p className="text-sm text-slate-500 tabular-nums sm:ml-2 whitespace-nowrap">
            {visible.length} of {data.items.length} {data.items.length === 1 ? noun : `${noun}s`}
          </p>
        </div>
      </div>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-6 space-y-4">
        {data.truncated && (
          <p className="rounded-lg bg-amber-50 ring-1 ring-amber-200 px-4 py-3 text-sm text-amber-800">
            Showing the first {data.items.length} {noun}s. Ask the organiser for the full list.
          </p>
        )}
        {visible.length === 0 ? (
          <div className="rounded-2xl bg-white ring-1 ring-slate-200 p-10 text-center">
            <FileText className="mx-auto h-8 w-8 text-slate-300 mb-3" />
            <p className="text-sm text-slate-500">
              {data.items.length === 0 ? `No ${noun}s to show yet.` : "Nothing matches your search."}
            </p>
          </div>
        ) : (
          visible.map((item) => <SubmissionCard key={item.number + item.title} item={item} has={has} />)
        )}
      </main>

      <footer className="py-6 text-center text-xs text-slate-400 print:hidden">{data.event.organizationName}</footer>
    </div>
  );
}

function SubmissionCard({ item, has }: { item: SharedItem; has: (key: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const meta: { label: string; value: string }[] = [];
  if (has("theme") && item.theme) meta.push({ label: "Theme", value: item.theme });
  if (has("track") && item.track) meta.push({ label: "Track", value: item.track });
  if (has("presentationType") && item.presentationType) meta.push({ label: "Type", value: item.presentationType });
  if (has("format") && item.format) meta.push({ label: "Format", value: item.format });
  if (has("duration") && item.duration) meta.push({ label: "Duration", value: item.duration });
  if (has("specialty") && item.specialty) meta.push({ label: "Specialty", value: item.specialty });
  if (has("submittedAt") && item.submittedAt) {
    meta.push({ label: "Submitted", value: new Date(item.submittedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) });
  }
  const contact = [item.authorEmail, item.authorAdditionalEmail, item.authorPhone].filter((v): v is string => !!v);
  const person = [item.authorName, item.authorAffiliation, item.authorCountry].filter(Boolean).join(" · ");
  const long = (item.body?.length ?? 0) > 420;

  return (
    <article className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm overflow-hidden break-inside-avoid">
      <div className="px-5 pt-4 pb-3 bg-gradient-to-r from-primary/[0.07] to-transparent border-b border-slate-100">
        <div className="flex items-start gap-3">
          <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary tabular-nums">{item.number}</span>
          <h2 className="flex-1 text-base font-semibold text-slate-900 leading-snug text-balance">{item.title}</h2>
          {item.status && (
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1", STATUS_TONE[item.status] ?? "bg-slate-50 text-slate-600 ring-slate-200")}>
              {STATUS_LABEL[item.status] ?? item.status}
            </span>
          )}
        </div>
        {person && <p className="mt-2 text-sm text-slate-600">{person}</p>}
        {item.coAuthors && item.coAuthors.length > 0 && (
          <p className="mt-1 text-xs text-slate-500">
            <span className="font-medium text-slate-600">Co-authors: </span>
            {item.coAuthors.join("; ")}
          </p>
        )}
        {contact.length > 0 && <p className="mt-1 text-xs text-slate-500 break-all">{contact.join(" · ")}</p>}
      </div>

      <div className="px-5 py-4 space-y-3">
        {meta.length > 0 && (
          <dl className="flex flex-wrap gap-2">
            {meta.map((m) => (
              <div key={m.label} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs">
                <dt className="text-slate-500">{m.label}:</dt>
                <dd className="font-medium text-slate-700">{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {item.body && (
          <div>
            <p className={cn("text-sm text-slate-700 leading-relaxed whitespace-pre-wrap max-w-prose", !open && long && "line-clamp-4 print:line-clamp-none")}>
              {item.body}
            </p>
            {long && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="mt-1 text-sm font-medium text-primary hover:underline print:hidden"
                aria-expanded={open}
              >
                {open ? "Show less" : "Read more"}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
