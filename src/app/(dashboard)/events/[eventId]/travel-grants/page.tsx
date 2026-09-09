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
  CalendarClock,
  Copy,
  Download,
  Eye,
  Loader2,
  Plane,
  Send,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { usePreviewEmailBySlug } from "@/hooks/use-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResidencyBadge, GrantStatusLabel } from "@/components/travel-grant/travel-grant-badges";
import {
  GRANT_STATUS_LABEL,
  RESIDENCY_LABEL_FIXED,
  residencyLabel,
  publicTravelGrantUrl,
} from "@/lib/travel-grant/constants";
import type { ResidencyClass } from "@/lib/travel-grant/eligibility";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";


interface Row {
  speakerId: string;
  name: string;
  email: string | null;
  organization: string | null;
  country: string | null;
  residency: ResidencyClass;
  abstractCount: number;
  grant: {
    id: string;
    status: "PENDING" | "CONSENTED" | "DECLINED";
    token: string;
    invitedAt: string | null;
    submittedAt: string | null;
    signedName: string | null;
    decidedBy: string | null;
  } | null;
}

interface Payload {
  enabled: boolean;
  /**
   * Display names of the countries this event treats as local.
   *
   * OPTIONAL on purpose. A response is not a type: a new bundle can reach an
   * older container during a deploy swap, and `undefined.length` here is a
   * white page on the console an organizer opens to chase people. The speaker
   * card already coerced this; the page did not, which is the inconsistency
   * that made it worth typing honestly rather than guarding at each use.
   */
  homeCountries?: string[];
  eventSlug: string;
  /** Application deadline (Sep 9, 2026): the instant, the verdict, the wording. */
  deadline?: string | null;
  deadlinePassed?: boolean;
  deadlineText?: string | null;
  rows: Row[];
  counts: {
    consented: number;
    pending: number;
    declined: number;
    notEligibleHome: number;
    countryNotRecorded: number;
  };
}

export default function TravelGrantsPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params?.eventId;

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // The send dialog (Sep 9, 2026): both "Remind N pending" and the per-row
  // send go through it, so every send can be previewed and can carry a
  // subject and a personal note. One dialog, one preview, one submit.
  const [sendTarget, setSendTarget] = useState<{ kind: "pending" } | { kind: "row"; row: Row } | null>(null);
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);
  const previewMutation = usePreviewEmailBySlug(eventId ?? "");

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
    async (body: Record<string, unknown>, key: string): Promise<boolean> => {
      if (!eventId) return false;
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
          return false;
        }
        const bits = [`Sent ${json.sent}`];
        if (json.failed) bits.push(`${json.failed} failed`);
        if (json.skippedNotEligible) bits.push(`${json.skippedNotEligible} not eligible`);
        if (json.skippedNoEmail) bits.push(`${json.skippedNoEmail} without an email`);
        if (json.sent === 0 && !json.failed) toast.info("Nobody to send to.");
        else if (json.failed) toast.warning(bits.join(" · "));
        else toast.success(bits.join(" · "));
        await load();
        return true;
      } catch {
        toast.error("Couldn't send. Please try again.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [eventId, load],
  );

  const openSend = useCallback((target: { kind: "pending" } | { kind: "row"; row: Row }) => {
    setSendSubject("");
    setSendMessage("");
    setSendTarget(target);
  }, []);

  const submitSend = useCallback(async () => {
    if (!sendTarget) return;
    const overrides = {
      ...(sendSubject.trim() ? { subject: sendSubject.trim() } : {}),
      ...(sendMessage.trim() ? { message: sendMessage.trim() } : {}),
    };
    const ok =
      sendTarget.kind === "pending"
        ? await send({ target: "pending", ...overrides }, "remind")
        : await send({ speakerIds: [sendTarget.row.speakerId], ...overrides }, sendTarget.row.speakerId);
    if (ok) setSendTarget(null);
  }, [send, sendTarget, sendSubject, sendMessage]);

  // Exactly what the send renders: the event's own template with the typed
  // subject and note, the organizer's message, button text and deadline. A
  // per-row preview greets THAT author with their real link; the reminder
  // keeps a representative greeting (audience-level previews stay
  // representative, July 29, 2026).
  const handlePreview = useCallback(async () => {
    if (!sendTarget) return;
    try {
      const result = await previewMutation.mutateAsync({
        slug: "travel-grant-invitation",
        speakerId: sendTarget.kind === "row" ? sendTarget.row.speakerId : undefined,
        customSubject: sendSubject.trim() || undefined,
        customMessage: sendMessage.trim() || undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (err) {
      console.error("travel-grants:preview-error", err);
      toast.error(err instanceof Error ? err.message : "Couldn't build the preview.");
    }
  }, [previewMutation, sendTarget, sendSubject, sendMessage]);

  // Organizer override of the author's answer (Sep 8, 2026): reopen, or
  // record applied / declined on their behalf. The author's own form is locked
  // after they answer, so this is the only way to change it.
  const setStatus = useCallback(
    async (row: Row, status: "PENDING" | "CONSENTED" | "DECLINED") => {
      if (!eventId || !row.grant) return;
      setBusy(`status:${row.speakerId}`);
      try {
        const res = await fetch(`/api/events/${eventId}/travel-grants/${row.grant.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(json.error || "Couldn't change the status.");
          return;
        }
        // A reopen past the deadline does not reopen the LINK: the author's
        // page keeps saying "Applications closed" until the deadline is
        // extended, so the toast must not promise an answer that cannot arrive.
        const reopenedText = data?.deadlinePassed
          ? `Reopened for ${row.name}. Applications are closed, so their link stays closed until you extend the deadline under Settings → Abstracts.`
          : `Reopened for ${row.name}: their link accepts a new answer.`;
        toast.success(
          status === "PENDING"
            ? reopenedText
            : `${row.name} recorded as ${GRANT_STATUS_LABEL[status].toLowerCase()} (set by you).`,
        );
        await load();
      } catch {
        toast.error("Couldn't change the status. Please try again.");
      } finally {
        setBusy(null);
      }
    },
    [eventId, load, data?.deadlinePassed],
  );

  const copyLink = useCallback(
    (row: Row) => {
      if (!row.grant || !data) return;
      const url = publicTravelGrantUrl(window.location.origin, data.eventSlug, row.grant.token);
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

  // Coerced ONCE, so no render path below can reach an absent field. Guarding at
  // each use invites the next use to forget.
  const homeCountries = Array.isArray(data.homeCountries) ? data.homeCountries : [];

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
            onClick={() => openSend({ kind: "pending" })}
            disabled={busy !== null || data.counts.pending === 0 || data.deadlinePassed === true}
            title={data.deadlinePassed ? "Applications closed; extend the deadline to send again" : undefined}
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

      {data.deadlinePassed && (
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Applications <strong>closed on {data.deadlineText}</strong>. Sending is paused and the
            authors&rsquo; links no longer accept answers. Extend the deadline under{" "}
            <strong>Settings &rarr; Abstracts</strong> to send again. You can still set a status by
            hand from the row menu.
          </p>
        </div>
      )}
      {!data.deadlinePassed && data.deadlineText && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          Applications close on {data.deadlineText}.
        </p>
      )}

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
        <Stat label={GRANT_STATUS_LABEL.CONSENTED} value={data.counts.consented} tone="emerald" />
        <Stat label={GRANT_STATUS_LABEL.PENDING} value={data.counts.pending} tone="amber" />
        <Stat label={GRANT_STATUS_LABEL.DECLINED} value={data.counts.declined} />
        <Stat
          label={residencyLabel("home", homeCountries)}
          value={data.counts.notEligibleHome}
          // The badge shortens a 2+ list to "Local"; the tile names them all,
          // which is the owner's decision on where the full list belongs.
          hint={homeCountries.length > 1 ? homeCountries.join(", ") : undefined}
        />
        <Stat
          label={RESIDENCY_LABEL_FIXED.unknown}
          value={data.counts.countryNotRecorded}
          tone="rose"
        />
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
                        <ResidencyBadge residency={r.residency} homeCountries={homeCountries} />
                      </td>
                      <td className="px-4 py-3">
                        <GrantStatusLabel
                          status={r.grant?.status ?? null}
                          signedName={r.grant?.signedName}
                          decidedBy={r.grant?.decidedBy}
                        />
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
                            disabled={
                              busy !== null ||
                              r.residency !== "overseas" ||
                              !r.email ||
                              data.deadlinePassed === true
                            }
                            title={
                              data.deadlinePassed
                                ? "Applications closed; extend the deadline to send again"
                                : r.residency !== "overseas"
                                  ? "Not eligible — correct the country on their profile first"
                                  : !r.email
                                    ? "No email address on file"
                                    : "Send their link"
                            }
                            onClick={() => openSend({ kind: "row", row: r })}
                          >
                            {busy === r.speakerId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          {r.grant && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy !== null}
                                  title="Set status on the author's behalf"
                                >
                                  {busy === `status:${r.speakerId}` ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Set status</DropdownMenuLabel>
                                <DropdownMenuItem
                                  disabled={r.grant.status === "CONSENTED"}
                                  onSelect={() => void setStatus(r, "CONSENTED")}
                                >
                                  Mark as applied
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={r.grant.status === "DECLINED"}
                                  onSelect={() => void setStatus(r, "DECLINED")}
                                >
                                  Mark as declined
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={r.grant.status === "PENDING"}
                                  onSelect={() => void setStatus(r, "PENDING")}
                                >
                                  Reopen (await reply)
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
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

      <Dialog open={sendTarget !== null} onOpenChange={(open) => { if (!open) setSendTarget(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {sendTarget?.kind === "row"
                ? `Send the link to ${sendTarget.row.name}`
                : `Remind ${data.counts.pending} pending author${data.counts.pending === 1 ? "" : "s"}`}
            </DialogTitle>
            <DialogDescription>
              {sendTarget?.kind === "row" ? (
                <>
                  <strong>{sendTarget.row.email}</strong> receives their personal link, using the{" "}
                  <em>Travel Grant Invitation</em> template with your message, button text and deadline
                  from Settings and Content.
                </>
              ) : (
                <>
                  Everyone invited who has not answered yet receives their link again. Authors who
                  already applied or declined, and anyone no longer eligible, are skipped.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tg-send-subject">Subject (optional)</Label>
              <Input
                id="tg-send-subject"
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder="Leave blank to use the template's subject"
                maxLength={300}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tg-send-message">Personal note (optional)</Label>
              <Textarea
                id="tg-send-message"
                value={sendMessage}
                onChange={(e) => setSendMessage(e.target.value)}
                placeholder="A line or two above the button, e.g. why you are writing again."
                rows={4}
                maxLength={5000}
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={previewMutation.isPending || busy !== null}
            >
              {previewMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              Preview
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setSendTarget(null)} disabled={busy !== null}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void submitSend()} disabled={busy !== null}>
                {busy !== null ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Send
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {previewData && (
        <EmailPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          subject={previewData.subject}
          htmlContent={previewData.htmlContent}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone?: string;
  /** Shown on hover when the label had to shorten a list. */
  hint?: string;
}) {
  const colour =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "rose"
          ? "text-rose-600"
          : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-4" title={hint}>
      <div className={`text-2xl font-semibold tabular-nums ${colour}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
