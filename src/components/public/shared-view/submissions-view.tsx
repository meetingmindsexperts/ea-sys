"use client";

/** The abstracts / session proposals layout: search, theme filter, one card each. */
import { useCallback, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SharedItem } from "@/lib/submission-share";
import { FilterSelect, SearchBox, SharedShell, TruncatedNote } from "./shell";
import type { SubmissionsPayload } from "./types";

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

export function SubmissionsView({ data }: { data: SubmissionsPayload }) {
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState("all");
  const has = useCallback((key: string) => data.fields.includes(key), [data]);

  // The theme filter exists only when the theme itself is shown, or its
  // options would reveal a value the organiser chose to hide.
  const themes = useMemo(() => {
    if (!has("theme")) return [];
    return [...new Set(data.items.map((i) => i.theme).filter((t): t is string => !!t))].sort();
  }, [data, has]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.items.filter((i) => {
      if (theme !== "all" && i.theme !== theme) return false;
      if (!q) return true;
      return [i.number, i.title, i.authorName, i.theme, i.authorAffiliation, ...(i.coAuthors ?? [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [data, query, theme]);

  const noun = data.kind === "ABSTRACTS" ? "abstract" : "session proposal";
  const heading = data.kind === "ABSTRACTS" ? "Abstracts" : "Session proposals";

  return (
    <SharedShell
      event={data.event}
      eyebrow={heading}
      generatedAt={data.generatedAt}
      toolbar={
        <>
          <SearchBox value={query} onChange={setQuery} placeholder={`Search ${heading.toLowerCase()}`} />
          {themes.length > 0 && <FilterSelect value={theme} onChange={setTheme} label="Filter by theme" allLabel="All themes" options={themes} />}
          <p className="text-sm text-slate-500 tabular-nums sm:ml-2 whitespace-nowrap">
            {visible.length} of {data.items.length} {data.items.length === 1 ? noun : `${noun}s`}
          </p>
        </>
      }
    >
      {data.truncated && <TruncatedNote count={data.items.length} noun={`${noun}s`} />}
      {visible.length === 0 ? (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 p-10 text-center">
          <FileText className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm text-slate-500">{data.items.length === 0 ? `No ${noun}s to show yet.` : "Nothing matches your search."}</p>
        </div>
      ) : (
        visible.map((item) => <SubmissionCard key={item.number + item.title} item={item} has={has} />)
      )}
    </SharedShell>
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
