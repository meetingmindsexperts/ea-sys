"use client";

/**
 * Dinner RSVP — organizer console.
 *
 * Manage the event's dinners (Day 1 Dinner, Day 2 Gala…), build the
 * invite list (manual + import from Registrations/Speakers), and read the
 * roster: per-invitee responses, per-dinner headcount tiles, CSV export,
 * and each invitee's personalized RSVP link to copy/share. Email delivery
 * of links is P2. Docs: docs/DINNER_RSVP.md.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  UtensilsCrossed,
  Plus,
  Trash2,
  Copy,
  Download,
  Loader2,
  CalendarDays,
  Check,
  Clock,
  Send,
  BellRing,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { ImportInviteesDialog } from "@/components/dinner/import-invitees-dialog";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import { usePreviewEmailBySlug, useEvent } from "@/hooks/use-api";
import {
  resolveTimezone,
  localDateTimeInTz,
  wallTimeInTzToDate,
  tzLabel,
} from "@/lib/event-time";
import { toast } from "sonner";

interface Dinner {
  id: string;
  name: string;
  dinnerAt: string;
  location: string | null;
  description: string | null;
  rsvpDeadline: string | null;
  sortOrder: number;
  isActive: boolean;
}
interface RosterInvite {
  id: string;
  inviteeName: string;
  inviteeEmail: string;
  token: string;
  dietary: string | null;
  status: string;
  respondedAt: string | null;
  responses: { dinnerId: string; attending: boolean; guestCount: number }[];
}
interface Headcount {
  dinnerId: string;
  attendees: number;
  guests: number;
  total: number;
}

const emptyDinner = {
  name: "",
  dinnerAt: "",
  location: "",
  description: "",
  rsvpDeadline: "",
};

export default function DinnerRsvpPage() {
  const { eventId } = useParams<{ eventId: string }>();
  // Dinner times display AND edit in the EVENT's timezone (review M10) —
  // same recipe as the agenda page, so both surfaces show one clock.
  const { data: eventData } = useEvent(eventId);
  const eventInfo = eventData as { timezone?: string | null; startDate?: string } | undefined;
  const dinnerTz = resolveTimezone(eventInfo?.timezone);
  // Label anchored to the event's start date (not "now") — deterministic
  // under React render purity and DST-correct for the event window.
  const dinnerTzName = tzLabel(
    eventInfo?.startDate ? new Date(eventInfo.startDate) : new Date(0),
    dinnerTz,
  );
  const [slug, setSlug] = useState<string>("");
  const [dinners, setDinners] = useState<Dinner[]>([]);
  const [invites, setInvites] = useState<RosterInvite[]>([]);
  const [headcounts, setHeadcounts] = useState<Headcount[]>([]);
  const [loading, setLoading] = useState(true);

  const [dinnerDialog, setDinnerDialog] = useState(false);
  const [editingDinner, setEditingDinner] = useState<Dinner | null>(null);
  const [dinnerForm, setDinnerForm] = useState({ ...emptyDinner });
  const [savingDinner, setSavingDinner] = useState(false);

  const [inviteDialog, setInviteDialog] = useState(false);
  const [inviteRows, setInviteRows] = useState<{ name: string; email: string }[]>([
    { name: "", email: "" },
  ]);
  const [savingInvites, setSavingInvites] = useState(false);

  const [importDialog, setImportDialog] = useState(false);

  const [sendDialog, setSendDialog] = useState(false);
  const [sendTarget, setSendTarget] = useState<"all" | "pending">("all");
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [sending, setSending] = useState(false);

  const previewMutation = usePreviewEmailBySlug(eventId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const loadRoster = useCallback(async () => {
    const res = await fetch(`/api/events/${eventId}/rsvp-invites`);
    if (res.ok) {
      const json = await res.json();
      setDinners(json.dinners);
      setInvites(json.invites);
      setHeadcounts(json.headcounts);
    } else {
      console.error("dinner-console:roster-load-failed", res.status);
      toast.error("Couldn't load the RSVP roster");
    }
  }, [eventId]);

  useEffect(() => {
    (async () => {
      try {
        const [ev] = await Promise.all([fetch(`/api/events/${eventId}`), loadRoster()]);
        if (ev.ok) setSlug((await ev.json()).slug || "");
        else console.error("dinner-console:event-load-failed", ev.status);
      } catch (err) {
        console.error("dinner-console:init-error", err);
        toast.error("Couldn't load the dinner console");
      } finally {
        setLoading(false);
      }
    })();
  }, [eventId, loadRoster]);

  // ── Dinner CRUD ──
  const openNewDinner = () => {
    setEditingDinner(null);
    setDinnerForm({ ...emptyDinner });
    setDinnerDialog(true);
  };
  const openEditDinner = (d: Dinner) => {
    setEditingDinner(d);
    setDinnerForm({
      name: d.name,
      // The datetime-local inputs operate in the EVENT's timezone (review
      // M10, agenda-page recipe): localDateTimeInTz on the way in,
      // wallTimeInTzToDate on the way out — a lossless, DST-safe inverse
      // pair. What the organizer types is the event-local wall clock.
      dinnerAt: localDateTimeInTz(new Date(d.dinnerAt), dinnerTz),
      location: d.location ?? "",
      description: d.description ?? "",
      rsvpDeadline: d.rsvpDeadline ? localDateTimeInTz(new Date(d.rsvpDeadline), dinnerTz) : "",
    });
    setDinnerDialog(true);
  };
  const saveDinner = async () => {
    if (!dinnerForm.name.trim() || !dinnerForm.dinnerAt) {
      toast.error("Name and date/time are required");
      return;
    }
    setSavingDinner(true);
    try {
      // Event-TZ inverse of the read-back above — the pairing is what makes
      // the round-trip lossless. Empty/invalid values write null.
      const fromEventTzInput = (v: string): string | null => {
        if (!v) return null;
        const d = wallTimeInTzToDate(v, dinnerTz);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      };
      const payload = {
        name: dinnerForm.name.trim(),
        dinnerAt: fromEventTzInput(dinnerForm.dinnerAt),
        location: dinnerForm.location.trim(),
        description: dinnerForm.description.trim(),
        rsvpDeadline: fromEventTzInput(dinnerForm.rsvpDeadline),
      };
      const res = await fetch(
        editingDinner
          ? `/api/events/${eventId}/dinners/${editingDinner.id}`
          : `/api/events/${eventId}/dinners`,
        {
          method: editingDinner ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        toast.error((await res.json()).error || "Failed to save dinner");
        return;
      }
      toast.success(editingDinner ? "Dinner updated" : "Dinner added");
      setDinnerDialog(false);
      await loadRoster();
    } catch (err) {
      console.error("dinner-console:save-dinner-error", err);
      toast.error("Failed to save dinner");
    } finally {
      setSavingDinner(false);
    }
  };
  const deleteDinner = async (d: Dinner) => {
    if (!confirm(`Delete "${d.name}"? This removes its RSVP responses.`)) return;
    try {
      const res = await fetch(`/api/events/${eventId}/dinners/${d.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Dinner deleted");
        await loadRoster();
      } else {
        console.error("dinner-console:delete-dinner-failed", res.status);
        toast.error("Failed to delete dinner");
      }
    } catch (err) {
      console.error("dinner-console:delete-dinner-error", err);
      toast.error("Failed to delete dinner");
    }
  };

  // ── Invitees ──
  const addInvites = async () => {
    const rows = inviteRows
      .map((r) => ({ name: r.name.trim(), email: r.email.trim() }))
      .filter((r) => r.name && r.email);
    if (rows.length === 0) {
      toast.error("Add at least one name + email");
      return;
    }
    setSavingInvites(true);
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitees: rows }),
      });
      if (!res.ok) {
        toast.error((await res.json()).error || "Failed to add invitees");
        return;
      }
      const { created, skipped } = await res.json();
      toast.success(`${created} invited${skipped ? `, ${skipped} already on the list` : ""}`);
      setInviteDialog(false);
      setInviteRows([{ name: "", email: "" }]);
      await loadRoster();
    } catch (err) {
      console.error("dinner-console:add-invites-error", err);
      toast.error("Failed to add invitees");
    } finally {
      setSavingInvites(false);
    }
  };
  const removeInvite = async (inv: RosterInvite) => {
    if (!confirm(`Remove ${inv.inviteeName} from the RSVP list?`)) return;
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-invites/${inv.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Removed");
        await loadRoster();
      } else {
        console.error("dinner-console:remove-invite-failed", res.status);
        toast.error("Failed to remove");
      }
    } catch (err) {
      console.error("dinner-console:remove-invite-error", err);
      toast.error("Failed to remove");
    }
  };
  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${origin}/e/${slug}/rsvp/${token}`).then(
      () => toast.success("RSVP link copied"),
      (err) => {
        console.error("dinner-console:copy-link-error", err);
        toast.error("Couldn't copy the link");
      },
    );
  };
  const [sendingOneId, setSendingOneId] = useState<string | null>(null);
  const sendOne = async (inv: RosterInvite) => {
    setSendingOneId(inv.id);
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-invites/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId: inv.id }),
      });
      const json = await res.json();
      if (!res.ok || json.sent === 0) {
        console.error("dinner-console:send-one-failed", res.status, json?.error);
        toast.error(json.error || "Couldn't send the invitation");
        return;
      }
      toast.success(`Invitation emailed to ${inv.inviteeName}`);
      await loadRoster();
    } catch (err) {
      console.error("dinner-console:send-one-error", err);
      toast.error("Couldn't send the invitation");
    } finally {
      setSendingOneId(null);
    }
  };
  const openSend = (target: "all" | "pending") => {
    setSendTarget(target);
    setSendDialog(true);
  };
  const openPreview = async () => {
    try {
      const result = await previewMutation.mutateAsync({
        slug: "dinner-rsvp-invitation",
        customSubject: sendSubject.trim() || undefined,
        customMessage: sendMessage.trim() || undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (err) {
      console.error("dinner-console:preview-error", err);
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    }
  };
  const sendInvitations = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-invites/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: sendTarget,
          subject: sendSubject.trim() || undefined,
          message: sendMessage.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to send");
        return;
      }
      toast.success(`Sent ${json.sent}${json.failed ? `, ${json.failed} failed` : ""}`);
      setSendDialog(false);
      await loadRoster();
    } catch (err) {
      console.error("dinner-console:send-error", err);
      toast.error("Failed to send invitations");
    } finally {
      setSending(false);
    }
  };

  const headByDinner = useMemo(
    () => new Map(headcounts.map((h) => [h.dinnerId, h])),
    [headcounts],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const respondedCount = invites.filter((i) => i.status === "RESPONDED").length;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UtensilsCrossed className="h-6 w-6 text-primary" /> Dinner RSVP
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Invite people to the event dinners and track who&rsquo;s coming.
          </p>
        </div>
        <div className="flex gap-2">
          {invites.length > 0 && (
            <Button size="sm" onClick={() => openSend("all")}>
              <Send className="h-4 w-4 mr-1" /> Email invitations
            </Button>
          )}
          <a href={`/api/events/${eventId}/rsvp-invites?export=csv`}>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </a>
        </div>
      </div>

      {/* How it works */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
        <div className="font-semibold text-primary mb-1">How Dinner RSVP works</div>
        <ol className="list-decimal ml-5 space-y-1 text-slate-600">
          <li><strong>Add each dinner</strong> below (name, date/time, venue, and an optional RSVP deadline).</li>
          <li><strong>Add or import invitees</strong> — type them in, or import from Registrations/Speakers.</li>
          <li>
            <strong>Send them their link.</strong> Click <strong>Email invitations</strong> to email everyone
            (or <strong>Remind pending</strong> for non-responders), use the <Send className="inline h-3 w-3" />{" "}
            button on a row to email <strong>one person</strong>, or the <Copy className="inline h-3 w-3" /> button
            to copy an individual link and send it yourself (WhatsApp, etc.).
          </li>
          <li><strong>Track responses</strong> in the roster — who&rsquo;s coming to each dinner, guests, and dietary needs. Export CSV for catering.</li>
        </ol>
        <p className="text-xs text-slate-500 mt-2">
          Each invitee gets <strong>one personalized link that covers all the dinners</strong> and can update
          their answer until the deadline. Edit the invitation wording under <strong>Communications → Email Templates</strong> (Dinner RSVP Invitation).
        </p>
      </div>

      {/* Dinners */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Dinners</h2>
          <Button size="sm" onClick={openNewDinner}>
            <Plus className="h-4 w-4 mr-1" /> Add dinner
          </Button>
        </div>
        {dinners.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
            No dinners yet. Add Day 1 Dinner, Day 2 Gala, etc.
          </CardContent></Card>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {dinners.map((d) => {
              const h = headByDinner.get(d.id);
              return (
                <Card key={d.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{d.name}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {`${new Date(d.dinnerAt).toLocaleString("en-US", {
                            weekday: "short", day: "numeric", month: "short",
                            hour: "numeric", minute: "2-digit",
                            timeZone: dinnerTz,
                          })} ${tzLabel(new Date(d.dinnerAt), dinnerTz)}`}
                        </div>
                        {d.location && <div className="text-xs text-muted-foreground mt-0.5">{d.location}</div>}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditDinner(d)}>
                          <Clock className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => deleteDinner(d)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 text-sm">
                      <span className="font-bold text-primary">{h?.attendees ?? 0}</span>{" "}
                      attending{h && h.guests > 0 ? ` (+${h.guests} guests)` : ""}
                      <span className="text-muted-foreground"> · {h?.total ?? 0} total seats</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Roster */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">
            Invitees{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({respondedCount}/{invites.length} responded)
            </span>
          </h2>
          <div className="flex gap-2">
            {invites.some((i) => i.status === "PENDING") && (
              <Button size="sm" variant="outline" onClick={() => openSend("pending")}>
                <BellRing className="h-4 w-4 mr-1" /> Remind pending
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setImportDialog(true)}>
              <Users className="h-4 w-4 mr-1" /> Import
            </Button>
            <Button size="sm" onClick={() => setInviteDialog(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add invitees
            </Button>
          </div>
        </div>
        {invites.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
            No invitees yet. Add people, then copy each personalized RSVP link to send.
          </CardContent></Card>
        ) : (
          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">Name</th>
                  <th className="p-2 font-medium">Status</th>
                  {dinners.map((d) => (
                    <th key={d.id} className="p-2 font-medium text-center whitespace-nowrap">{d.name}</th>
                  ))}
                  <th className="p-2 font-medium">Dietary</th>
                  <th className="p-2 font-medium text-right">Link</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => {
                  const byDinner = new Map(inv.responses.map((r) => [r.dinnerId, r]));
                  return (
                    <tr key={inv.id} className="border-t">
                      <td className="p-2">
                        <div className="font-medium">{inv.inviteeName}</div>
                        <div className="text-xs text-muted-foreground">{inv.inviteeEmail}</div>
                      </td>
                      <td className="p-2">
                        {inv.status === "RESPONDED" ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-medium">
                            <Check className="h-3.5 w-3.5" /> Responded
                          </span>
                        ) : (
                          <span className="text-xs text-amber-600 font-medium">Pending</span>
                        )}
                      </td>
                      {dinners.map((d) => {
                        const r = byDinner.get(d.id);
                        return (
                          <td key={d.id} className="p-2 text-center">
                            {r?.attending ? (
                              <span className="text-emerald-600 font-medium">
                                Yes{r.guestCount > 0 ? ` +${r.guestCount}` : ""}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="p-2 max-w-[160px] truncate text-muted-foreground">{inv.dietary || "—"}</td>
                      <td className="p-2 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Email this invitation"
                          disabled={sendingOneId === inv.id}
                          onClick={() => sendOne(inv)}
                        >
                          {sendingOneId === inv.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Copy RSVP link" onClick={() => copyLink(inv.token)}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" title="Remove" onClick={() => removeInvite(inv)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Dinner dialog */}
      <Dialog open={dinnerDialog} onOpenChange={setDinnerDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingDinner ? "Edit dinner" : "Add dinner"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name *</Label>
              <Input
                value={dinnerForm.name}
                onChange={(e) => setDinnerForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Day 1 Dinner"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>Date &amp; time * ({dinnerTzName})</Label>
                <Input
                  type="datetime-local"
                  value={dinnerForm.dinnerAt}
                  onChange={(e) => setDinnerForm((f) => ({ ...f, dinnerAt: e.target.value }))}
                />
              </div>
              <div>
                <Label>RSVP deadline ({dinnerTzName})</Label>
                <Input
                  type="datetime-local"
                  value={dinnerForm.rsvpDeadline}
                  onChange={(e) => setDinnerForm((f) => ({ ...f, rsvpDeadline: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Location</Label>
              <Input
                value={dinnerForm.location}
                onChange={(e) => setDinnerForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="Ballroom, Al Habtoor"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={dinnerForm.description}
                onChange={(e) => setDinnerForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDinnerDialog(false)}>Cancel</Button>
            <Button onClick={saveDinner} disabled={savingDinner}>
              {savingDinner ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite dialog */}
      <Dialog open={inviteDialog} onOpenChange={setInviteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add invitees</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-[50vh] overflow-y-auto">
            {inviteRows.map((row, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Name"
                  value={row.name}
                  onChange={(e) =>
                    setInviteRows((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                  }
                />
                <Input
                  placeholder="Email"
                  type="email"
                  value={row.email}
                  onChange={(e) =>
                    setInviteRows((rows) => rows.map((r, j) => (j === i ? { ...r, email: e.target.value } : r)))
                  }
                />
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInviteRows((rows) => [...rows, { name: "", email: "" }])}
            >
              <Plus className="h-4 w-4 mr-1" /> Add row
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteDialog(false)}>Cancel</Button>
            <Button onClick={addInvites} disabled={savingInvites}>
              {savingInvites ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import dialog */}
      <ImportInviteesDialog
        eventId={eventId}
        open={importDialog}
        onOpenChange={setImportDialog}
        existingEmails={new Set(invites.map((i) => i.inviteeEmail.toLowerCase()))}
        onImported={loadRoster}
      />

      {/* Send dialog */}
      <Dialog open={sendDialog} onOpenChange={setSendDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {sendTarget === "pending" ? "Remind pending invitees" : "Email RSVP invitations"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {sendTarget === "pending"
                ? `Sends to the ${invites.filter((i) => i.status === "PENDING").length} invitee(s) who haven't responded yet.`
                : `Sends to all ${invites.length} invitee(s). Each gets their own personalized RSVP link.`}
            </p>
            <div>
              <Label>Subject (optional)</Label>
              <Input
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder={`You're invited — ${slug ? "" : ""}the event dinners`}
              />
            </div>
            <div>
              <Label>Message (optional)</Label>
              <Textarea
                value={sendMessage}
                onChange={(e) => setSendMessage(e.target.value)}
                rows={4}
                placeholder="A short note shown above the RSVP button. Leave blank for the default invitation text."
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Uses the <strong>Dinner RSVP Invitation</strong> email template (edit its wording
              &amp; branding under Communications → Email Templates). Click Preview to see it.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={openPreview} disabled={previewMutation.isPending}>
              {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Preview"}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSendDialog(false)}>Cancel</Button>
              <Button onClick={sendInvitations} disabled={sending}>
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-1" /> Send
                  </>
                )}
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
