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
 * Filters (Oct 23, 2026, Dina): registrations by type, status, payment status
 * and badge role; speakers and submitters by speaker status. They narrow the
 * list already loaded (no extra request), and "Select all" picks what they
 * leave, so a whole group is two clicks. Cancelled registrations are left out
 * by default; "Any status" brings them back.
 *
 * Docs: docs/RSVP.md.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, Users, Mic, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ANY,
  DEFAULT_FILTERS,
  NOT_CANCELLED,
  SPEAKER_DEFAULT_FILTERS,
  distinct,
  matchesFilters,
  titleCase,
  type Filters,
} from "@/lib/rsvp-import-filters";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  /** Registration status, or the speaker's status on the speaker tabs. */
  status?: string;
  /** Registrations only. */
  typeId?: string;
  typeName?: string;
  paymentStatus?: string;
  badgeType?: string;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function selectAllChecked(allSelected: boolean, selectedCount: number): boolean | "indeterminate" {
  if (allSelected) return true;
  if (selectedCount > 0) return "indeterminate";
  return false;
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
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const setFilter = (k: keyof Filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const switchSource = (next: typeof source) => {
    setSource(next);
    setFilters(next === "registrations" ? DEFAULT_FILTERS : SPEAKER_DEFAULT_FILTERS);
  };

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch("");
    setSource("registrations");
    setFilters(DEFAULT_FILTERS);
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
              status?: string;
              paymentStatus?: string;
              badgeType?: string | null;
              ticketType?: { id?: string; name?: string } | null;
              attendee?: { firstName?: string; lastName?: string; email?: string };
            }) =>
              r.attendee?.email
                ? [{
                    key: `reg:${r.id}`,
                    name: `${r.attendee.firstName ?? ""} ${r.attendee.lastName ?? ""}`.trim() || r.attendee.email,
                    email: r.attendee.email,
                    registrationId: r.id,
                    status: r.status,
                    paymentStatus: r.paymentStatus,
                    badgeType: r.badgeType?.trim() || undefined,
                    typeId: r.ticketType?.id,
                    typeName: r.ticketType?.name?.trim(),
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
            status?: string;
            submitterSource?: string | null;
          }) =>
            s.email
              ? [{
                  person: {
                    key: `spk:${s.id}`,
                    name: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.email,
                    email: s.email,
                    speakerId: s.id,
                    status: s.status,
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

  const people = { registrations: regs, speakers, submitters }[source];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter((p) => {
      if (!matchesFilters(p, filters)) return false;
      return !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
    });
  }, [people, search, filters]);
  const defaults = source === "registrations" ? DEFAULT_FILTERS : SPEAKER_DEFAULT_FILTERS;
  const narrowed = !!search.trim() || JSON.stringify(filters) !== JSON.stringify(defaults);

  // Options come from the people loaded, so a filter never offers an empty choice.
  const typeOptions = useMemo(() => {
    const byId = new Map(regs.filter((r) => r.typeId).map((r) => [r.typeId as string, r.typeName || "Untitled type"]));
    return [...byId].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  }, [regs]);
  const statusValues = useMemo(() => distinct(people.map((p) => p.status)), [people]);
  const paymentValues = useMemo(() => distinct(regs.map((r) => r.paymentStatus)), [regs]);
  const badgeValues = useMemo(() => distinct(regs.map((r) => r.badgeType)), [regs]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // "Select all" acts on the LIST AS FILTERED and only on people not already
  // invited, so a search narrows what it picks and it never touches a
  // selection the search is hiding: tick, search, tick again accumulates, the
  // way per-row ticks do (the reimbursement picker's rule, Sep 8 2026). Before
  // this the dialog was one tick per person: 109 clicks to invite an event.
  const addable = useMemo(
    () => filtered.filter((p) => !existingEmails.has(p.email.toLowerCase())),
    [filtered, existingEmails],
  );
  const addableSelectedCount = useMemo(
    () => addable.filter((p) => selected.has(p.key)).length,
    [addable, selected],
  );
  const allAddableSelected = addable.length > 0 && addableSelectedCount === addable.length;
  const toggleSelectAll = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of addable) {
        if (checked) next.add(p.key);
        else next.delete(p.key);
      }
      return next;
    });

  const doImport = async () => {
    // Submitters are their own tab, so they must be in the pool the ticks are
    // resolved against; without them a ticked submitter was silently dropped
    // from the import (found while adding select-all, Sep 10 2026).
    const all = [...regs, ...speakers, ...submitters];
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
          <DialogDescription>
            Pick people from this event. Narrow the list with the filters, then use Select all to add a whole group.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant={source === "registrations" ? "default" : "outline"}
            onClick={() => switchSource("registrations")}
          >
            <Users className="h-4 w-4 mr-1" /> Registrations ({regs.length})
          </Button>
          <Button
            size="sm"
            variant={source === "speakers" ? "default" : "outline"}
            onClick={() => switchSource("speakers")}
          >
            <Mic className="h-4 w-4 mr-1" /> Speakers ({speakers.length})
          </Button>
          <Button
            size="sm"
            variant={source === "submitters" ? "default" : "outline"}
            onClick={() => switchSource("submitters")}
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

        <div className="flex flex-wrap items-center gap-2">
          {source === "registrations" && (
            <FilterSelect
              label="Registration type"
              value={filters.type}
              onChange={setFilter("type")}
              options={[{ value: ANY, label: "Any type" }, ...typeOptions]}
            />
          )}
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={setFilter("status")}
            options={[
              ...(source === "registrations" ? [{ value: NOT_CANCELLED, label: "Not cancelled" }] : []),
              { value: ANY, label: "Any status" },
              ...statusValues.map((v) => ({ value: v, label: titleCase(v) })),
            ]}
          />
          {source === "registrations" && (
            <>
              <FilterSelect
                label="Payment status"
                value={filters.payment}
                onChange={setFilter("payment")}
                options={[{ value: ANY, label: "Any payment" }, ...paymentValues.map((v) => ({ value: v, label: titleCase(v) }))]}
              />
              <FilterSelect
                label="Badge role"
                value={filters.badge}
                onChange={setFilter("badge")}
                options={[{ value: ANY, label: "Any badge role" }, ...badgeValues.map((v) => ({ value: v, label: v }))]}
              />
            </>
          )}
          {narrowed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => { setFilters(defaults); setSearch(""); }}
            >
              Clear filters
            </Button>
          )}
        </div>

        <div className="border rounded-lg max-h-[45vh] overflow-y-auto divide-y">
          {loading && (
            <div className="py-10 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          )}
          {!loading && (filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No people found.</div>
          ) : (
            <>
              {addable.length > 0 && (
                <label className="flex items-center gap-3 px-3 py-2 cursor-pointer bg-muted/30 hover:bg-muted/50">
                  <Checkbox
                    checked={selectAllChecked(allAddableSelected, addableSelectedCount)}
                    // Radix reports a click on an indeterminate box as `true`,
                    // so "some picked" → "all picked", then → none.
                    onCheckedChange={(v) => toggleSelectAll(v === true)}
                    aria-label="Select all listed people"
                  />
                  <span className="flex-1 text-sm font-medium">
                    Select all{narrowed ? " matching" : ""} ({addable.length})
                  </span>
                  {selected.size > 0 && (
                    <span className="text-xs text-muted-foreground">{selected.size} selected</span>
                  )}
                </label>
              )}
              {filtered.map((p) => {
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
              })}
            </>
          ))}
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
