"use client";

/**
 * RSVP — import invitees from Registrations / Speakers / Submitters.
 *
 * Fetches the event's registrations + speakers, lets the organizer
 * multi-select (searchable), and POSTs them to the CAMPAIGN's invites route
 * with the source `registrationId`/`speakerId` set. Already-invited emails are
 * shown disabled. The POST de-dups on (campaignId, email) server-side, so
 * re-importing is safe — and the same person may be imported into a DIFFERENT
 * RSVP on the same event, which is the point of the campaign layer.
 *
 * Submitters are `Speaker` rows carrying `submitterSource` (the abstract /
 * proposal self-signup doors), so they need no separate fetch — just a filter
 * over the speakers we already have.
 *
 * Docs: docs/RSVP.md.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Users, Mic, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface Person {
  key: string;
  name: string;
  email: string;
  registrationId?: string;
  speakerId?: string;
}

export function ImportInviteesDialog({
  eventId,
  campaignId,
  open,
  onOpenChange,
  existingEmails,
  onImported,
}: {
  eventId: string;
  campaignId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existingEmails: Set<string>;
  onImported: () => void | Promise<void>;
}) {
  const [source, setSource] = useState<"registrations" | "speakers" | "submitters">("registrations");
  const [regs, setRegs] = useState<Person[]>([]);
  const [speakers, setSpeakers] = useState<Person[]>([]);
  const [submitters, setSubmitters] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch("");
    setLoading(true);
    (async () => {
      try {
        const [rRes, sRes] = await Promise.all([
          fetch(`/api/events/${eventId}/registrations`),
          fetch(`/api/events/${eventId}/speakers`),
        ]);
        if (rRes.ok) {
          const rows = await rRes.json();
          setRegs(
            (Array.isArray(rows) ? rows : []).flatMap((r: {
              id: string;
              attendee?: { firstName?: string; lastName?: string; email?: string };
            }) =>
              r.attendee?.email
                ? [{
                    key: `reg:${r.id}`,
                    name: `${r.attendee.firstName ?? ""} ${r.attendee.lastName ?? ""}`.trim() || r.attendee.email,
                    email: r.attendee.email,
                    registrationId: r.id,
                  }]
                : [],
            ),
          );
        } else {
          // R2 L2: a silent failure here rendered "No people found." — the
          // organizer concluded the event had no registrations.
          console.error("import-invitees:registrations-load-failed", rRes.status);
          toast.error("Couldn't load registrations — try reopening the dialog.");
        }
        if (sRes.ok) {
          const rows = await sRes.json();
          const mapped = (Array.isArray(rows) ? rows : []).flatMap((s: {
            id: string;
            firstName?: string;
            lastName?: string;
            email?: string;
            submitterSource?: string | null;
          }) =>
            s.email
              ? [{
                  person: {
                    key: `spk:${s.id}`,
                    name: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.email,
                    email: s.email,
                    speakerId: s.id,
                  } as Person,
                  isSubmitter: Boolean(s.submitterSource),
                }]
              : [],
          );
          // One fetch, two tabs: a submitter IS a Speaker row (with
          // submitterSource set by the abstract/proposal signup door), so
          // splitting here beats a second endpoint.
          setSpeakers(mapped.filter((m) => !m.isSubmitter).map((m) => m.person));
          setSubmitters(mapped.filter((m) => m.isSubmitter).map((m) => m.person));
        } else {
          console.error("import-invitees:speakers-load-failed", sRes.status);
          toast.error("Couldn't load speakers — try reopening the dialog.");
        }
      } catch (err) {
        console.error("import-invitees:load-error", err);
        toast.error("Couldn't load people to import");
      } finally {
        setLoading(false);
      }
    })();
  }, [open, eventId]);

  const people = source === "registrations" ? regs : source === "speakers" ? speakers : submitters;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  }, [people, search]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const doImport = async () => {
    const all = [...regs, ...speakers];
    const picked = all.filter((p) => selected.has(p.key));
    if (picked.length === 0) {
      toast.error("Select at least one person");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp-campaigns/${campaignId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invitees: picked.map((p) => ({
            name: p.name,
            email: p.email,
            registrationId: p.registrationId,
            speakerId: p.speakerId,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("import-invitees:save-failed", res.status, json?.error);
        toast.error(json.error || "Failed to import");
        return;
      }
      toast.success(`${json.created} imported${json.skipped ? `, ${json.skipped} already on the list` : ""}`);
      onOpenChange(false);
      await onImported();
    } catch (err) {
      console.error("import-invitees:save-error", err);
      toast.error("Failed to import");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import invitees</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant={source === "registrations" ? "default" : "outline"}
            onClick={() => setSource("registrations")}
          >
            <Users className="h-4 w-4 mr-1" /> Registrations ({regs.length})
          </Button>
          <Button
            size="sm"
            variant={source === "speakers" ? "default" : "outline"}
            onClick={() => setSource("speakers")}
          >
            <Mic className="h-4 w-4 mr-1" /> Speakers ({speakers.length})
          </Button>
          <Button
            size="sm"
            variant={source === "submitters" ? "default" : "outline"}
            onClick={() => setSource("submitters")}
          >
            <FileText className="h-4 w-4 mr-1" /> Submitters ({submitters.length})
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email"
            className="pl-8"
          />
        </div>

        <div className="border rounded-lg max-h-[45vh] overflow-y-auto divide-y">
          {loading ? (
            <div className="py-10 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No people found.</div>
          ) : (
            filtered.map((p) => {
              const invited = existingEmails.has(p.email.toLowerCase());
              return (
                <label
                  key={p.key}
                  className={`flex items-center gap-3 px-3 py-2 ${
                    invited ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted/40"
                  }`}
                >
                  <Checkbox
                    checked={selected.has(p.key)}
                    disabled={invited}
                    onCheckedChange={() => toggle(p.key)}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{p.email}</div>
                  </div>
                  {invited && <span className="ml-auto text-xs text-muted-foreground">Already invited</span>}
                </label>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={doImport} disabled={saving || selected.size === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : `Add ${selected.size || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
