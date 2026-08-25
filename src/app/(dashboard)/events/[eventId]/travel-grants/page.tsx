"use client";

/**
 * Travel Grants console.
 *
 * Lists EVERY abstract author on the event, not only the invited ones
 * (decision D7). A UAE-based author and an author with no country recorded both
 * appear, because routing is purely the country on their profile and an author
 * wrongly classed as UAE gets nothing at all with no way to know an offer
 * existed. Showing them here is what makes that recoverable.
 *
 * The consequence is that this table contains people who must NOT be emailed,
 * directly above a bulk send button. The server resolves reminder recipients
 * from the grant table rather than from these rows, and re-checks eligibility
 * on a named send, so neither path can reach them. See lib/travel-grant/send.ts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  Plane,
  Send,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Residency = "uae" | "overseas" | "unknown";
type GrantStatus = "PENDING" | "CONSENTED" | "DECLINED";

interface Row {
  speakerId: string;
  name: string;
  email: string | null;
  organization: string | null;
  country: string | null;
  residency: Residency;
  abstractCount: number;
  grant: {
    id: string;
    status: GrantStatus;
    token: string;
    invitedAt: string | null;
    submittedAt: string | null;
    signedName: string | null;
  } | null;
}

interface Payload {
  enabled: boolean;
  eventSlug: string;
  rows: Row[];
  counts: {
    consented: number;
    pending: number;
    declined: number;
    notEligibleUae: number;
    countryNotRecorded: number;
  };
}

const RESIDENCY_LABEL: Record<Residency, string> = {
  overseas: "Eligible",
  uae: "UAE — not eligible",
  unknown: "Country not recorded",
};

export default function TravelGrantsPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params?.eventId;

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const res = await fetch(`/api/events/${eventId}/travel-grants`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Couldn't load travel grants.");
        return;
      }
      setError(null);
      setData(json as Payload);
    } catch {
      setError("Couldn't load travel grants. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      if (!eventId) return;
      setBusy(key);
      try {
        const res = await fetch(`/api/events/${eventId}/travel-grants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(json.error || "Couldn't send.");
          return;
        }
        const bits = [`Sent ${json.sent}`];
        if (json.failed) bits.push(`${json.failed} failed`);
        if (json.skippedNotEligible) bits.push(`${json.skippedNotEligible} not eligible`);
        if (json.skippedNoEmail) bits.push(`${json.skippedNoEmail} without an email`);
        if (json.sent === 0 && !json.failed) toast.info("Nobody to send to.");
        else if (json.failed) toast.warning(bits.join(" · "));
        else toast.success(bits.join(" · "));
        await load();
      } catch {
        toast.error("Couldn't send. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [eventId, load],
  );

  const copyLink = useCallback(
    (row: Row) => {
      if (!row.grant || !data) return;
      const url = `${window.location.origin}/e/${data.eventSlug}/travel-grant/${row.grant.token}`;
      void navigator.clipboard
        .writeText(url)
        .then(() => toast.success("Link copied"))
        .catch(() => toast.error("Couldn't copy the link"));
    },
    [data],
  );

  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.email ?? "").toLowerCase().includes(q) ||
        (r.country ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="font-medium">{error ?? "Couldn't load travel grants."}</p>
        <Button variant="outline" className="mt-4" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2">
            <Plane className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Travel Grants</h1>
            <p className="text-sm text-muted-foreground">
              Every author who has submitted an abstract, and where they stand.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => window.open(`/api/events/${eventId}/travel-grants?export=csv`, "_blank")}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button
            onClick={() => void send({ target: "pending" }, "remind")}
            disabled={busy !== null || data.counts.pending === 0}
          >
            {busy === "remind" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Remind {data.counts.pending} pending
          </Button>
        </div>
      </div>

      {!data.enabled && (
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Travel Grant is <strong>switched off</strong> for this event, so no new invitations go
            out. Turn it on under <strong>Settings &rarr; Abstracts</strong>. Answers already given
            are shown below.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Confirmed" value={data.counts.consented} tone="emerald" />
        <Stat label="Awaiting reply" value={data.counts.pending} tone="amber" />
        <Stat label="Declined" value={data.counts.declined} />
        <Stat label="UAE, not eligible" value={data.counts.notEligibleUae} />
        <Stat label="Country not recorded" value={data.counts.countryNotRecorded} tone="rose" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <CardTitle className="text-base">Authors ({filtered.length})</CardTitle>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or country…"
            className="max-w-xs"
          />
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No abstract authors yet. Invitations go out automatically as abstracts are submitted.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Author</th>
                    <th className="px-4 py-2 font-medium">Country</th>
                    <th className="px-4 py-2 font-medium">Eligibility</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.speakerId} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.email ?? "no email"}</div>
                      </td>
                      <td className="px-4 py-3">
                        {r.country ?? <span className="text-muted-foreground">&mdash;</span>}
                      </td>
                      <td className="px-4 py-3">
                        <ResidencyBadge residency={r.residency} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusCell row={r} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          {r.grant && (
                            <Button size="sm" variant="ghost" onClick={() => copyLink(r)}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null || r.residency !== "overseas" || !r.email}
                            title={
                              r.residency !== "overseas"
                                ? "Not eligible — correct the country on their profile first"
                                : !r.email
                                  ? "No email address on file"
                                  : "Send their link"
                            }
                            onClick={() => void send({ speakerIds: [r.speakerId] }, r.speakerId)}
                          >
                            {busy === r.speakerId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const colour =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "rose"
          ? "text-rose-600"
          : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className={`text-2xl font-semibold tabular-nums ${colour}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ResidencyBadge({ residency }: { residency: Residency }) {
  if (residency === "overseas") {
    return <Badge variant="outline" className="border-emerald-300 text-emerald-700">Eligible</Badge>;
  }
  if (residency === "uae") {
    return <Badge variant="outline" className="text-muted-foreground">{RESIDENCY_LABEL.uae}</Badge>;
  }
  return (
    <Badge variant="outline" className="border-rose-300 text-rose-700" title="Not emailed. Correct the country on their profile, then send their link.">
      {RESIDENCY_LABEL.unknown}
    </Badge>
  );
}

function StatusCell({ row }: { row: Row }) {
  if (!row.grant) return <span className="text-muted-foreground">Not invited</span>;
  if (row.grant.status === "CONSENTED") {
    return (
      <span className="flex items-center gap-1.5 text-emerald-700">
        <Check className="h-3.5 w-3.5" />
        Confirmed
        {row.grant.signedName && (
          <span className="text-xs text-muted-foreground">({row.grant.signedName})</span>
        )}
      </span>
    );
  }
  if (row.grant.status === "DECLINED") {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <X className="h-3.5 w-3.5" />
        Declined
      </span>
    );
  }
  return <span className="text-amber-700">Awaiting reply</span>;
}
