"use client";

/**
 * RSVPs — the event's list of RSVPs (a gala dinner, parallel workshops, a site
 * visit). Each one owns its OWN options and its OWN guest list.
 *
 * ⚠ The campaign layer must not cost the organizer a step
 * (docs/CUSTOMIZABLE_RSVP_PLAN.md §2a). "New RSVP" is ONE form that creates the
 * campaign AND its first option together, so an event running a single dinner
 * goes: New RSVP → add invitees → send. Exactly the three steps it always was.
 * The options list and the Options panel only appear once there is a second
 * option to distinguish — which is the moment the distinction starts to mean
 * something.
 *
 * Docs: docs/RSVP.md.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  CalendarCheck,
  Plus,
  Loader2,
  ChevronRight,
  Users,
  Settings2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { useEvent } from "@/hooks/use-api";
import { resolveTimezone, localDateTimeInTz, wallTimeInTzToDate, tzLabel } from "@/lib/event-time";
import { toast } from "sonner";

interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  selectionMode: "SINGLE" | "MULTI";
  allowGuests: boolean;
  collectDietary: boolean;
  isActive: boolean;
  itemCount: number;
  inviteCount: number;
  respondedCount: number;
}

const emptyForm = {
  name: "",
  description: "",
  // The first option, submitted in the same request (§2a).
  startsAt: "",
  location: "",
  // Options, behind a disclosure. Defaults reproduce the historical dinner
  // behavior so an organizer who only runs dinners never sees any of this.
  selectionMode: "MULTI" as "SINGLE" | "MULTI",
  allowGuests: true,
  collectDietary: true,
};

export default function RsvpCampaignsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { data: eventInfo } = useEvent(eventId);
  const tz = resolveTimezone(eventInfo?.timezone);
  const tzName = tzLabel(new Date(), tz);

  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-campaigns`);
      if (!res.ok) {
        console.error("rsvp-list:load-failed", res.status);
        toast.error("Couldn't load the event's RSVPs");
        return;
      }
      setCampaigns((await res.json()).campaigns ?? []);
    } catch (err) {
      console.error("rsvp-list:load-error", err);
      toast.error("Couldn't load the event's RSVPs");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setForm({
      ...emptyForm,
      // Default the first option to the event's start, in the event's timezone.
      startsAt: eventInfo?.startDate
        ? localDateTimeInTz(new Date(eventInfo.startDate), tz)
        : "",
    });
    setShowOptions(false);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Give this RSVP a name");
      return;
    }
    if (!form.startsAt) {
      toast.error("Set a date and time");
      return;
    }
    setSaving(true);
    try {
      const startsAt = wallTimeInTzToDate(form.startsAt, tz);
      const res = await fetch(`/api/events/${eventId}/rsvp-campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          selectionMode: form.selectionMode,
          allowGuests: form.allowGuests,
          collectDietary: form.collectDietary,
          // Campaign + its first option in ONE request — see the file header.
          firstItem: {
            name: form.name.trim(),
            startsAt: startsAt.toISOString(),
            location: form.location.trim(),
          },
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        console.error("rsvp-list:create-failed", res.status, json?.error);
        toast.error(json?.error || "Failed to create the RSVP");
        return;
      }
      toast.success("RSVP created");
      setDialogOpen(false);
      await load();
    } catch (err) {
      console.error("rsvp-list:create-error", err);
      toast.error("Failed to create the RSVP");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: CampaignRow) => {
    if (
      !confirm(
        `Delete "${c.name}"? This removes its ${c.itemCount} option(s), ${c.inviteCount} invitee(s) and every response. This cannot be undone.`,
      )
    )
      return;
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-campaigns/${c.id}`, { method: "DELETE" });
      if (!res.ok) {
        console.error("rsvp-list:delete-failed", res.status);
        toast.error("Failed to delete the RSVP");
        return;
      }
      toast.success("RSVP deleted");
      await load();
    } catch (err) {
      console.error("rsvp-list:delete-error", err);
      toast.error("Failed to delete the RSVP");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarCheck className="h-6 w-6 text-primary" /> RSVPs
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Invite people to a dinner, a set of workshops, a site visit — each with its own guest
            list — and track who&rsquo;s coming.
          </p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> New RSVP
        </Button>
      </div>

      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CalendarCheck className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <div className="font-semibold">No RSVPs yet</div>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Create one per thing you need answers about. A gala dinner and a set of workshops are
              two separate RSVPs, because they usually go to different people.
            </p>
            <Button size="sm" className="mt-4" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" /> New RSVP
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => (
            <Card key={c.id} className="hover:border-primary/40 transition-colors">
              <CardContent className="p-4 flex items-center gap-4">
                <Link href={`/events/${eventId}/rsvp/${c.id}`} className="flex-1 min-w-0 group">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold group-hover:text-primary truncate">{c.name}</span>
                    {!c.isActive && (
                      <span className="text-xs rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                        Inactive
                      </span>
                    )}
                    {c.selectionMode === "SINGLE" && (
                      <span className="text-xs rounded px-1.5 py-0.5 bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                        Pick one
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground mt-0.5">
                    {c.itemCount} option{c.itemCount === 1 ? "" : "s"} ·{" "}
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {c.respondedCount} of {c.inviteCount} replied
                    </span>
                  </div>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(c)}
                  aria-label={`Delete ${c.name}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
                <Link href={`/events/${eventId}/rsvp/${c.id}`} aria-label={`Open ${c.name}`}>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New RSVP</DialogTitle>
            <DialogDescription>
              One form for both the RSVP and its first option. You can add more options afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="rsvp-name">Name *</Label>
              <Input
                id="rsvp-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Gala Dinner"
                className="mt-1"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="rsvp-when">Date &amp; time * ({tzName})</Label>
                <Input
                  id="rsvp-when"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="rsvp-where">Venue</Label>
                <Input
                  id="rsvp-where"
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                  placeholder="Madinat Jumeirah"
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="rsvp-desc">Note for invitees (optional)</Label>
              <Textarea
                id="rsvp-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={2}
                className="mt-1"
                placeholder="Black tie. Transport leaves the hotel at 19:15."
              />
            </div>

            {/* Progressive disclosure: defaults are today's dinner behavior, so
                an organizer who only runs dinners never opens this. */}
            {showOptions ? (
              <div className="rounded-lg border p-3 space-y-3">
                <div className="text-sm font-medium">Options</div>
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    checked={form.selectionMode === "SINGLE"}
                    onCheckedChange={(v) =>
                      setForm({ ...form, selectionMode: v === true ? "SINGLE" : "MULTI" })
                    }
                  />
                  <span className="text-sm">
                    Invitees pick <strong>one</strong> option only
                    <span className="block text-xs text-muted-foreground">
                      For parallel sessions. Leave off for dinners across several nights.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    checked={form.allowGuests}
                    onCheckedChange={(v) => setForm({ ...form, allowGuests: v === true })}
                  />
                  <span className="text-sm">
                    Ask how many guests they&rsquo;re bringing
                    <span className="block text-xs text-muted-foreground">
                      Usually on for a dinner, off for a workshop.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox
                    checked={form.collectDietary}
                    onCheckedChange={(v) => setForm({ ...form, collectDietary: v === true })}
                  />
                  <span className="text-sm">
                    Ask for dietary requirements
                    <span className="block text-xs text-muted-foreground">
                      Anything where food is served.
                    </span>
                  </span>
                </label>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowOptions(true)}
                className="text-muted-foreground"
              >
                <Settings2 className="h-4 w-4 mr-1" /> Options
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create RSVP"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
