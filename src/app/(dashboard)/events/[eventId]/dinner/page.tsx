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

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const loadRoster = useCallback(async () => {
    const res = await fetch(`/api/events/${eventId}/rsvp-invites`);
    if (res.ok) {
      const json = await res.json();
      setDinners(json.dinners);
      setInvites(json.invites);
      setHeadcounts(json.headcounts);
    }
  }, [eventId]);

  useEffect(() => {
    (async () => {
      try {
        const [ev] = await Promise.all([fetch(`/api/events/${eventId}`), loadRoster()]);
        if (ev.ok) setSlug((await ev.json()).slug || "");
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
      dinnerAt: d.dinnerAt.slice(0, 16),
      location: d.location ?? "",
      description: d.description ?? "",
      rsvpDeadline: d.rsvpDeadline ? d.rsvpDeadline.slice(0, 16) : "",
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
      const payload = {
        name: dinnerForm.name.trim(),
        dinnerAt: new Date(dinnerForm.dinnerAt).toISOString(),
        location: dinnerForm.location.trim(),
        description: dinnerForm.description.trim(),
        rsvpDeadline: dinnerForm.rsvpDeadline ? new Date(dinnerForm.rsvpDeadline).toISOString() : null,
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
    } finally {
      setSavingDinner(false);
    }
  };
  const deleteDinner = async (d: Dinner) => {
    if (!confirm(`Delete "${d.name}"? This removes its RSVP responses.`)) return;
    const res = await fetch(`/api/events/${eventId}/dinners/${d.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Dinner deleted");
      await loadRoster();
    } else {
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
    } finally {
      setSavingInvites(false);
    }
  };
  const removeInvite = async (inv: RosterInvite) => {
    if (!confirm(`Remove ${inv.inviteeName} from the RSVP list?`)) return;
    const res = await fetch(`/api/events/${eventId}/rsvp-invites/${inv.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Removed");
      await loadRoster();
    } else {
      toast.error("Failed to remove");
    }
  };
  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${origin}/e/${slug}/rsvp/${token}`);
    toast.success("RSVP link copied");
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
          <a href={`/api/events/${eventId}/rsvp-invites?export=csv`}>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </a>
        </div>
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
                          {new Date(d.dinnerAt).toLocaleString(undefined, {
                            weekday: "short", day: "numeric", month: "short",
                            hour: "numeric", minute: "2-digit",
                          })}
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
          <Button size="sm" onClick={() => setInviteDialog(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add invitees
          </Button>
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
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copyLink(inv.token)}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => removeInvite(inv)}>
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
                <Label>Date &amp; time *</Label>
                <Input
                  type="datetime-local"
                  value={dinnerForm.dinnerAt}
                  onChange={(e) => setDinnerForm((f) => ({ ...f, dinnerAt: e.target.value }))}
                />
              </div>
              <div>
                <Label>RSVP deadline</Label>
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
    </div>
  );
}
