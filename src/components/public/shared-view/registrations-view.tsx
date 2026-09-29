"use client";

/**
 * The registrations layout (docs/REGISTRATION_SHARE_PLAN.md §3.4): built for
 * scanning many short rows. A counts strip, search, a type filter (only when
 * the type is shown), then a table on desktop and cards on a phone. Columns
 * come from the fields the server returned; nothing here decides privacy.
 */
import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { REGISTRATION_SHARE_FIELDS, REGISTRATION_STATUS_LABEL, type SharedRegistration } from "@/lib/registration-share";
import { FilterSelect, SearchBox, SharedShell, TruncatedNote } from "./shell";
import type { RegistrationsPayload } from "./types";

const STATUS_TONE: Record<string, string> = {
  CONFIRMED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  CHECKED_IN: "bg-sky-50 text-sky-700 ring-sky-200",
  PENDING: "bg-amber-50 text-amber-700 ring-amber-200",
  WAITLISTED: "bg-violet-50 text-violet-700 ring-violet-200",
  CANCELLED: "bg-rose-50 text-rose-700 ring-rose-200",
};

type Column = { key: string; label: string; render: (r: SharedRegistration) => React.ReactNode };

function dateOnly(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
}

function timeOf(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 whitespace-nowrap", STATUS_TONE[status] ?? "bg-slate-50 text-slate-600 ring-slate-200")}>
      {REGISTRATION_STATUS_LABEL[status] ?? status}
    </span>
  );
}

const RENDER: Record<string, (r: SharedRegistration) => React.ReactNode> = {
  organization: (r) => r.organization,
  jobTitle: (r) => r.jobTitle,
  country: (r) => r.country,
  specialty: (r) => r.specialty,
  registrationType: (r) => r.registrationType,
  attendanceMode: (r) => r.attendanceMode,
  status: (r) => (r.status ? <StatusPill status={r.status} /> : null),
  checkedIn: (r) => (r.checkedInAt ? <span className="text-emerald-700">{timeOf(r.checkedInAt)}</span> : <span className="text-slate-400">No</span>),
  registeredAt: (r) => dateOnly(r.registeredAt),
  promoCode: (r) => (r.promoCode ? <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.promoCode}</code> : null),
  sponsor: (r) => r.sponsor,
  email: (r) => r.email,
  additionalEmail: (r) => r.additionalEmail,
  phone: (r) => r.phone,
};

export function RegistrationsView({ data }: { data: RegistrationsPayload }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");

  // Catalogue order, only the fields the server returned.
  const columns: Column[] = useMemo(
    () =>
      REGISTRATION_SHARE_FIELDS.filter((f) => data.fields.includes(f.key)).map((f) => ({
        key: f.key,
        label: f.label === "In person or virtual" ? "Attendance" : f.label,
        render: RENDER[f.key],
      })),
    [data.fields],
  );

  const types = useMemo(() => {
    if (!data.fields.includes("registrationType")) return [];
    return [...new Set(data.items.map((i) => i.registrationType).filter((t): t is string => !!t))].sort();
  }, [data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.items.filter((r) => {
      if (type !== "all" && r.registrationType !== type) return false;
      if (!q) return true;
      return [r.number, r.name, r.organization, r.email, r.additionalEmail, r.phone, r.promoCode, r.sponsor, r.country]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [data, query, type]);

  const s = data.summary;

  return (
    <SharedShell
      event={data.event}
      eyebrow={data.label}
      generatedAt={data.generatedAt}
      wide
      toolbar={
        <>
          <SearchBox value={query} onChange={setQuery} placeholder="Search name, organisation, number" />
          {types.length > 1 && <FilterSelect value={type} onChange={setType} label="Filter by registration type" allLabel="All types" options={types} />}
          <p className="text-sm text-slate-500 tabular-nums sm:ml-2 whitespace-nowrap">
            {visible.length} of {data.items.length}
          </p>
        </>
      }
    >
      {/* Counts strip: the "numbers" part of the owner's "numbers and names". */}
      <section aria-label="Totals" className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Stat label="Registrations" value={s.total} />
        <Stat label="Checked in" value={s.checkedIn} sub={s.total ? `${Math.round((s.checkedIn / s.total) * 100)}%` : undefined} />
        <div className="col-span-2 rounded-xl bg-white ring-1 ring-slate-200 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">By type</p>
          <div className="flex flex-wrap gap-1.5">
            {s.byType.length === 0 && <span className="text-sm text-slate-400">None yet</span>}
            {s.byType.map((t) => (
              <span key={t.label} className="inline-flex items-center gap-1.5 rounded-md bg-primary/5 ring-1 ring-primary/15 px-2 py-1 text-xs">
                <span className="text-slate-700">{t.label}</span>
                <span className="font-semibold tabular-nums text-primary">{t.count}</span>
              </span>
            ))}
          </div>
          {s.byStatus.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.byStatus.map((b) => (
                <span key={b.status} className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <StatusPill status={b.status} />
                  <span className="tabular-nums font-medium text-slate-700">{b.count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {data.truncated && <TruncatedNote count={data.items.length} noun="registrations" />}

      {visible.length === 0 ? (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 p-10 text-center">
          <Users className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          <p className="text-sm text-slate-500">{data.items.length === 0 ? "No registrations to show yet." : "Nothing matches your search."}</p>
        </div>
      ) : (
        <>
          {/* Desktop and print: a table. Wide content scrolls inside its own box. */}
          <div className="hidden md:block print:block rounded-xl bg-white ring-1 ring-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100/80 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-semibold">#</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Name</th>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className="px-3 py-2.5 font-semibold whitespace-nowrap">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => (
                  <tr key={r.number + r.name} className="hover:bg-primary/[0.03] break-inside-avoid">
                    <td className="px-3 py-2 tabular-nums text-slate-500 whitespace-nowrap">{r.number}</td>
                    <td className="px-3 py-2 font-medium text-slate-900 whitespace-nowrap">{r.name}</td>
                    {columns.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-slate-700">{c.render(r)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: one compact card per registration. */}
          <ul className="md:hidden print:hidden space-y-2">
            {visible.map((r) => (
              <li key={r.number + r.name} className="rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium text-slate-900">{r.name}</p>
                  <span className="text-xs tabular-nums text-slate-400">{r.number}</span>
                </div>
                {columns.length > 0 && (
                  <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                    {columns.map((c) => {
                      const v = c.render(r);
                      if (v === null || v === undefined || v === "") return null;
                      return (
                        <div key={c.key} className="contents">
                          <dt className="text-slate-500">{c.label}</dt>
                          <dd className="text-slate-700 break-words min-w-0">{v}</dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </SharedShell>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200 p-4 bg-gradient-to-br from-primary/[0.06] to-transparent">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
        {value}
        {sub && <span className="ml-2 text-sm font-medium text-slate-500">{sub}</span>}
      </p>
    </div>
  );
}
