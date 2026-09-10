"use client";

/**
 * RSVP campaign console — ONE RSVP's options, audience and roster.
 *
 * Manage this RSVP's options (dinner nights, workshop slots…), build the
 * invite list (manual + import from Registrations/Speakers), and read the
 * roster: per-invitee responses, per-option headcount tiles, CSV export,
 * and each invitee's personalized RSVP link to copy/share — plus email
 * delivery (Email invitations / Remind pending / per-row Send).
 * Docs: docs/RSVP.md.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CalendarCheck,
  ArrowLeft,
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
import { ImportInviteesDialog } from "@/components/rsvp/import-invitees-dialog";
import { EmailPreviewDialog } from "@/components/email-preview-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePreviewEmailBySlug, useEvent, useEmailTemplates } from "@/hooks/use-api";
import { isCustomTemplateSlug } from "@/lib/email-template-slugs";
import {
  resolveTimezone,
  localDateTimeInTz,
  wallTimeInTzToDate,
  tzLabel,
} from "@/lib/event-time";
import { toast } from "sonner";

/** The system template the console sends by default; a KEY, not a label (see the send route). */
const RSVP_TEMPLATE_SLUG = "dinner-rsvp-invitation";

interface RsvpCampaign {
  id: string;
  name: string;
  description: string | null;
  selectionMode: "SINGLE" | "MULTI";
  allowGuests: boolean;
  collectDietary: boolean;
  isActive: boolean;
}
interface RsvpItem {
  id: string;
  name: string;
  startsAt: string;
  location: string | null;
  description: string | null;
  rsvpDeadline: string | null;
  /** Seat cap ("close automatically at N attending"); null = unlimited. */
  capacity: number | null;
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
  responses: { itemId: string; attending: boolean; guestCount: number }[];
}
interface Headcount {
  itemId: string;
  attendees: number;
  guests: number;
  total: number;
  capacity: number | null;
  full: boolean;
}

const emptyItem = {
  name: "",
  startsAt: "",
  location: "",
  description: "",
  rsvpDeadline: "",
  capacity: "",
};

export default function RsvpCampaignConsole() {
  const { eventId, campaignId } = useParams<{ eventId: string; campaignId: string }>();
  const apiBase = `/api/events/${eventId}/rsvp-campaigns/${campaignId}`;
  // Item times display AND edit in the EVENT's timezone (review M10) —
  // same recipe as the agenda page, so both surfaces show one clock.
  const { data: eventData } = useEvent(eventId);
  const eventInfo = eventData as { timezone?: string | null; startDate?: string } | undefined;
  const itemTz = resolveTimezone(eventInfo?.timezone);
  // Label anchored to the event's start date (not "now") — deterministic
  // under React render purity and DST-correct for the event window.
  const itemTzName = tzLabel(
    eventInfo?.startDate ? new Date(eventInfo.startDate) : new Date(0),
    itemTz,
  );
  const [slug, setSlug] = useState<string>("");
  const [items, setItems] = useState<RsvpItem[]>([]);
  const [invites, setInvites] = useState<RosterInvite[]>([]);
  const [headcounts, setHeadcounts] = useState<Headcount[]>([]);
  const [loading, setLoading] = useState(true);

  const [itemDialog, setItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<RsvpItem | null>(null);
  const [itemForm, setItemForm] = useState({ ...emptyItem });
  const [savingItem, setSavingItem] = useState(false);

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
  // Which email carries the links (Sep 10, 2026): the RSVP invitation, or one
  // of the organiser's own saved templates (joining instructions with the
  // button inside, say). Other system templates are not offered; the send
  // route refuses them because it does not build their tokens.
  const [sendTemplateSlug, setSendTemplateSlug] = useState<string>(RSVP_TEMPLATE_SLUG);
  const templatesQuery = useEmailTemplates(eventId, sendDialog);
  const customTemplates = (
    (templatesQuery.data?.templates ?? []) as Array<{
      slug: string;
      name: string;
      isActive?: boolean;
      htmlContent?: string;
    }>
  ).filter((t) => t.isActive !== false && isCustomTemplateSlug(t.slug));
  const selectedCustomTemplate = customTemplates.find((t) => t.slug === sendTemplateSlug) ?? null;
  // An RSVP send whose email carries no link is an embarrassing send (the L15
  // rule for an empty RSVP), so a saved template without the token cannot go.
  const selectedTemplateLacksLink = Boolean(
    selectedCustomTemplate && !(selectedCustomTemplate.htmlContent ?? "").includes("{{rsvpLink}}"),
  );

  const [campaign, setCampaign] = useState<RsvpCampaign | null>(null);
  const previewMutation = usePreviewEmailBySlug(eventId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string } | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const loadRoster = useCallback(async () => {
    const res = await fetch(`${apiBase}/invites`);
    if (res.ok) {
      const json = await res.json();
      // The roster GET is the single source for this console: campaign config
      // (which drives the guests/dietary columns), options, invites, tiles.
      setCampaign(json.campaign);
      setItems(json.items);
      setInvites(json.invites);
      setHeadcounts(json.headcounts);
    } else {
      console.error("rsvp-console:roster-load-failed", res.status);
      toast.error("Couldn't load the RSVP roster");
    }
  }, [apiBase]);

  useEffect(() => {
    (async () => {
      try {
        const [ev] = await Promise.all([fetch(`/api/events/${eventId}`), loadRoster()]);
        if (ev.ok) setSlug((await ev.json()).slug || "");
        else {
          // R2 M11: a silent failure here left slug="" and Copy-link then
          // copied a broken /e//rsvp/… URL with a SUCCESS toast.
          console.error("rsvp-console:event-load-failed", ev.status);
          toast.error("Couldn't load the event details — RSVP links can't be copied. Reload the page.");
        }
      } catch (err) {
        console.error("rsvp-console:init-error", err);
        toast.error("Couldn't load this RSVP");
      } finally {
        setLoading(false);
      }
    })();
  }, [eventId, loadRoster]);

  // ── Option (item) CRUD ──
  const openNewItem = () => {
    setEditingItem(null);
    setItemForm({ ...emptyItem });
    setItemDialog(true);
  };
  const openEditItem = (d: RsvpItem) => {
    setEditingItem(d);
    setItemForm({
      name: d.name,
      // The datetime-local inputs operate in the EVENT's timezone (review
      // M10, agenda-page recipe): localDateTimeInTz on the way in,
      // wallTimeInTzToDate on the way out — a lossless, DST-safe inverse
      // pair. What the organizer types is the event-local wall clock.
      startsAt: localDateTimeInTz(new Date(d.startsAt), itemTz),
      location: d.location ?? "",
      description: d.description ?? "",
      rsvpDeadline: d.rsvpDeadline ? localDateTimeInTz(new Date(d.rsvpDeadline), itemTz) : "",
      capacity: d.capacity != null ? String(d.capacity) : "",
    });
    setItemDialog(true);
  };
  const saveItem = async () => {
    if (!itemForm.name.trim() || !itemForm.startsAt) {
      toast.error("Name and date/time are required");
      return;
    }
    const capacityRaw = itemForm.capacity.trim();
    const capacity = capacityRaw ? Number(capacityRaw) : null;
    if (capacity != null && (!Number.isInteger(capacity) || capacity < 1)) {
      toast.error("Seats must be a whole number of 1 or more, or empty for unlimited");
      return;
    }
    setSavingItem(true);
    try {
      // Event-TZ inverse of the read-back above — the pairing is what makes
      // the round-trip lossless. Empty/invalid values write null.
      const fromEventTzInput = (v: string): string | null => {
        if (!v) return null;
        const d = wallTimeInTzToDate(v, itemTz);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      };
      const payload = {
        name: itemForm.name.trim(),
        startsAt: fromEventTzInput(itemForm.startsAt),
        location: itemForm.location.trim(),
        description: itemForm.description.trim(),
        rsvpDeadline: fromEventTzInput(itemForm.rsvpDeadline),
        // Empty = unlimited (explicit null, so an edit can clear a cap).
        capacity,
      };
      const res = await fetch(
        editingItem
          ? `${apiBase}/items/${editingItem.id}`
          : `${apiBase}/items`,
        {
          method: editingItem ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        toast.error((await res.json()).error || "Failed to save item");
        return;
      }
      toast.success(editingItem ? "Item updated" : "Item added");
      setItemDialog(false);
      await loadRoster();
    } catch (err) {
      console.error("rsvp-console:save-item-error", err);
      toast.error("Failed to save item");
    } finally {
      setSavingItem(false);
    }
  };
  const deleteItem = async (d: RsvpItem) => {
    if (!confirm(`Delete "${d.name}"? This removes its RSVP responses.`)) return;
    try {
      const res = await fetch(`${apiBase}/items/${d.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Option deleted");
        await loadRoster();
      } else {
        console.error("rsvp-console:delete-item-failed", res.status);
        toast.error("Failed to delete item");
      }
    } catch (err) {
      console.error("rsvp-console:delete-item-error", err);
      toast.error("Failed to delete item");
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
      const res = await fetch(`${apiBase}/invites`, {
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
      console.error("rsvp-console:add-invites-error", err);
      toast.error("Failed to add invitees");
    } finally {
      setSavingInvites(false);
    }
  };
  const removeInvite = async (inv: RosterInvite) => {
    if (!confirm(`Remove ${inv.inviteeName} from the RSVP list?`)) return;
    try {
      const res = await fetch(`${apiBase}/invites/${inv.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Removed");
        await loadRoster();
      } else {
        console.error("rsvp-console:remove-invite-failed", res.status);
        toast.error("Failed to remove");
      }
    } catch (err) {
      console.error("rsvp-console:remove-invite-error", err);
      toast.error("Failed to remove");
    }
  };
  const copyLink = (token: string) => {
    if (!slug) {
      // R2 M11: never hand out a broken /e//rsvp/… link with a green toast.
      toast.error("Event details haven't loaded — reload the page and try again.");
      return;
    }
    navigator.clipboard.writeText(`${origin}/e/${slug}/rsvp/${token}`).then(
      () => toast.success("RSVP link copied"),
      (err) => {
        console.error("rsvp-console:copy-link-error", err);
        toast.error("Couldn't copy the link");
      },
    );
  };
  // Per-row Send opens the SAME dialog in single mode (the reimbursement
  // console's Sep 8 pattern), so the template, subject and note apply to one
  // person too. It used to post straight away with the default invitation.
  const [sendInvite, setSendInvite] = useState<RosterInvite | null>(null);
  const openSendOne = (inv: RosterInvite) => {
    setSendInvite(inv);
    setSendTemplateSlug(RSVP_TEMPLATE_SLUG);
    setSendDialog(true);
  };
  const openSend = (target: "all" | "pending") => {
    setSendInvite(null);
    setSendTarget(target);
    setSendTemplateSlug(RSVP_TEMPLATE_SLUG);
    setSendDialog(true);
  };
  const openPreview = async () => {
    try {
      const result = await previewMutation.mutateAsync({
        slug: sendTemplateSlug,
        customSubject: sendSubject.trim() || undefined,
        customMessage: sendMessage.trim() || undefined,
      });
      setPreviewData(result);
      setPreviewOpen(true);
    } catch (err) {
      console.error("rsvp-console:preview-error", err);
      toast.error(err instanceof Error ? err.message : "Failed to generate preview");
    }
  };
  const sendInvitations = async () => {
    setSending(true);
    try {
      const res = await fetch(`${apiBase}/invites/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Single mode sends to exactly one invitee (never skipped as a
          // recent resend); bulk mode sends the batch.
          ...(sendInvite ? { inviteId: sendInvite.id } : { target: sendTarget }),
          subject: sendSubject.trim() || undefined,
          message: sendMessage.trim() || undefined,
          templateSlug: sendTemplateSlug !== RSVP_TEMPLATE_SLUG ? sendTemplateSlug : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to send");
        return;
      }
      const skippedNote = json.skippedRecentlyInvited
        ? ` (${json.skippedRecentlyInvited} skipped — already emailed in the last 10 minutes)`
        : "";
      // R2 L1: a total failure ("Sent 0, 3 failed") must not toast green.
      if (json.sent === 0 && json.failed > 0) {
        toast.error(`No emails sent — ${json.failed} failed${skippedNote}`);
        return;
      }
      toast.success(
        sendInvite
          ? `Invitation emailed to ${sendInvite.inviteeName}`
          : `Sent ${json.sent}${json.failed ? `, ${json.failed} failed` : ""}${skippedNote}`,
      );
      setSendDialog(false);
      await loadRoster();
    } catch (err) {
      console.error("rsvp-console:send-error", err);
      toast.error("Failed to send invitations");
    } finally {
      setSending(false);
    }
  };

  const headByItem = useMemo(
    () => new Map(headcounts.map((h) => [h.itemId, h])),
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
        <div className="min-w-0">
          <Link
            href={`/events/${eventId}/rsvp`}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-3 w-3" /> All RSVPs
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2 mt-1">
            <CalendarCheck className="h-6 w-6 text-primary" />
            {campaign?.name ?? "RSVP"}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {campaign?.description ||
              "Invite people and track who\u2019s coming."}
            {campaign && (
              <span className="ml-1">
                {campaign.selectionMode === "SINGLE" ? "Invitees pick one option." : "Invitees can pick several."}
                {campaign.allowGuests ? " Guests allowed." : ""}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {invites.length > 0 && (
            <Button size="sm" onClick={() => openSend("all")}>
              <Send className="h-4 w-4 mr-1" /> Email invitations
            </Button>
          )}
          <a href={`${apiBase}/invites?export=csv`}>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </a>
        </div>
      </div>

      {/* How it works */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
        <div className="font-semibold text-primary mb-1">How this RSVP works</div>
        <ol className="list-decimal ml-5 space-y-1 text-slate-600">
          <li><strong>Add each option</strong> below (name, date/time, venue, and an optional RSVP deadline). One option is fine.</li>
          <li><strong>Add or import invitees</strong> — type them in, or import from Registrations/Speakers.</li>
          <li>
            <strong>Send them their link.</strong> Click <strong>Email invitations</strong> to email everyone
            (or <strong>Remind pending</strong> for non-responders), use the <Send className="inline h-3 w-3" />{" "}
            button on a row to email <strong>one person</strong>, or the <Copy className="inline h-3 w-3" /> button
            to copy an individual link and send it yourself (WhatsApp, etc.).
          </li>
          <li><strong>Track responses</strong> in the roster — who&rsquo;s coming to each option, guests, and dietary needs. Export CSV for catering.</li>
        </ol>
        <p className="text-xs text-slate-500 mt-2">
          Each invitee gets <strong>one personalized link covering this RSVP&rsquo;s options</strong> and can update
          their answer until the deadline. Someone invited to another RSVP on this event gets a separate link for it.
          Edit the invitation wording under <strong>Communications → Email Templates</strong> (RSVP Invitation).
        </p>
      </div>

      {/* Options */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Options</h2>
          <Button size="sm" onClick={openNewItem}>
            <Plus className="h-4 w-4 mr-1" /> Add option
          </Button>
        </div>
        {items.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nothing to RSVP to yet. Add the dinner, the workshop slots, the site visit — whatever this RSVP is for.
          </CardContent></Card>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((d) => {
              const h = headByItem.get(d.id);
              return (
                <Card key={d.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{d.name}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {`${new Date(d.startsAt).toLocaleString("en-US", {
                            weekday: "short", day: "numeric", month: "short",
                            hour: "numeric", minute: "2-digit",
                            timeZone: itemTz,
                          })} ${tzLabel(new Date(d.startsAt), itemTz)}`}
                        </div>
                        {d.location && <div className="text-xs text-muted-foreground mt-0.5">{d.location}</div>}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditItem(d)}>
                          <Clock className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => deleteItem(d)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 text-sm">
                      <span className="font-bold text-primary">{h?.attendees ?? 0}</span>{" "}
                      attending{h && h.guests > 0 ? ` (+${h.guests} guests)` : ""}
                      <span className="text-muted-foreground">
                        {" "}· {h?.total ?? 0}
                        {d.capacity != null ? ` of ${d.capacity}` : " total"} seats
                      </span>
                      {h?.full && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          Full, closed to new yeses
                        </span>
                      )}
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
                  {items.map((d) => (
                    <th key={d.id} className="p-2 font-medium text-center whitespace-nowrap">{d.name}</th>
                  ))}
                  <th className="p-2 font-medium">Dietary</th>
                  <th className="p-2 font-medium text-right">Link</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => {
                  const byItem = new Map(inv.responses.map((r) => [r.itemId, r]));
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
                      {items.map((d) => {
                        const r = byItem.get(d.id);
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
                          disabled={sending && sendInvite?.id === inv.id}
                          onClick={() => openSendOne(inv)}
                        >
                          {sending && sendInvite?.id === inv.id ? (
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

      {/* Option dialog */}
      <Dialog open={itemDialog} onOpenChange={setItemDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit option" : "Add option"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name *</Label>
              <Input
                value={itemForm.name}
                onChange={(e) => setItemForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Day 1 Dinner"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>Date &amp; time * ({itemTzName})</Label>
                <Input
                  type="datetime-local"
                  value={itemForm.startsAt}
                  onChange={(e) => setItemForm((f) => ({ ...f, startsAt: e.target.value }))}
                />
              </div>
              <div>
                <Label>RSVP deadline ({itemTzName})</Label>
                <Input
                  type="datetime-local"
                  value={itemForm.rsvpDeadline}
                  onChange={(e) => setItemForm((f) => ({ ...f, rsvpDeadline: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Close automatically at (seats)</Label>
              <Input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={itemForm.capacity}
                onChange={(e) => setItemForm((f) => ({ ...f, capacity: e.target.value }))}
                placeholder="Leave empty for unlimited"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Seats are attendees plus their guests. When the number is reached the form stops
                taking new yeses for this option; people already attending keep their seat and can
                still change their mind. Raise or clear it to reopen.
              </p>
            </div>
            <div>
              <Label>Location</Label>
              <Input
                value={itemForm.location}
                onChange={(e) => setItemForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="Ballroom, Al Habtoor"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={itemForm.description}
                onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setItemDialog(false)}>Cancel</Button>
            <Button onClick={saveItem} disabled={savingItem}>
              {savingItem ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
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
        campaignId={campaignId}
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
              {sendInvite
                ? `Email ${sendInvite.inviteeName}`
                : sendTarget === "pending"
                  ? "Remind pending invitees"
                  : "Email RSVP invitations"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {sendInvite
                ? `Sends only to ${sendInvite.inviteeName} (${sendInvite.inviteeEmail}) with their personal RSVP link.`
                : sendTarget === "pending"
                  ? `Sends to the ${invites.filter((i) => i.status === "PENDING").length} invitee(s) who haven't responded yet.`
                  : `Sends to all ${invites.length} invitee(s). Each gets their own personalized RSVP link.`}
            </p>
            <div>
              <Label>Email template</Label>
              <Select value={sendTemplateSlug} onValueChange={setSendTemplateSlug}>
                <SelectTrigger aria-label="Email template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={RSVP_TEMPLATE_SLUG}>Dinner RSVP Invitation (system template)</SelectItem>
                  {customTemplates.map((t) => (
                    <SelectItem key={t.slug} value={t.slug}>
                      {t.name} (your saved template)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTemplateLacksLink && (
                <p className="text-xs text-amber-700 mt-1">
                  This template does not contain{" "}
                  <code className="bg-muted px-1 rounded">{"{{rsvpLink}}"}</code>, so invitees would get
                  no link. Add the token to it under Communications → Email Templates first.
                </p>
              )}
            </div>
            <div>
              <Label>Subject (optional)</Label>
              <Input
                value={sendSubject}
                onChange={(e) => setSendSubject(e.target.value)}
                placeholder="You're invited — the event items"
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
              {selectedCustomTemplate ? (
                <>
                  Uses your <strong>{selectedCustomTemplate.name}</strong>{" "}
                  template: the message above lands in its <code className="bg-muted px-1 rounded">{"{{message}}"}</code> slot and
                  every recipient gets their own{" "}
                  <code className="bg-muted px-1 rounded">{"{{rsvpLink}}"}</code>.
                </>
              ) : (
                <>
                  Uses the <strong>Dinner RSVP Invitation</strong>{" "}
                  email template (edit its wording &amp; branding under Communications → Email Templates).
                </>
              )}{" "}
              Click Preview to see it.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={openPreview} disabled={previewMutation.isPending}>
              {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Preview"}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSendDialog(false)}>Cancel</Button>
              <Button onClick={sendInvitations} disabled={sending || selectedTemplateLacksLink}>
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
