"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Building2, Plus, Pencil, CalendarDays, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBillingAccounts, useBillingAccount, useCreateBillingAccount,
  useUpdateBillingAccount, useEvents, queryKeys,
} from "@/hooks/use-api";

type Payer = {
  id: string;
  name: string;
  type: "INSTITUTION" | "COMPANY" | "OTHER";
  email: string | null;
  phone: string | null;
  contactName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
  needsReview: boolean;
  _count?: { registrations: number; events?: number };
};

type EventRow = { id: string; name: string; startDate: string };
type PayerDetail = {
  id: string;
  attachedEvents?: { eventId: string; event: { id: string; name: string } }[];
};

const EMPTY = {
  name: "", type: "INSTITUTION" as Payer["type"], email: "", phone: "",
  contactName: "", address: "", city: "", state: "", zipCode: "",
  country: "", taxNumber: "", notes: "",
};

export function BillingAccountsCard() {
  const { data: accounts = [], isLoading } = useBillingAccounts({ includeInactive: "1" });
  const create = useCreateBillingAccount();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Payer | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  const update = useUpdateBillingAccount(editing?.id ?? "");
  const queryClient = useQueryClient();
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Manage which events a payer is attached to (per-event scoping).
  const [eventsDialogFor, setEventsDialogFor] = useState<Payer | null>(null);
  // Merge a duplicate payer into a survivor (the needsReview review action).
  const [mergeDialogFor, setMergeDialogFor] = useState<Payer | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY });
    setOpen(true);
  };
  const openEdit = (p: Payer) => {
    setEditing(p);
    setForm({
      name: p.name, type: p.type, email: p.email ?? "", phone: p.phone ?? "",
      contactName: p.contactName ?? "", address: p.address ?? "", city: p.city ?? "",
      state: p.state ?? "", zipCode: p.zipCode ?? "", country: p.country ?? "",
      taxNumber: p.taxNumber ?? "", notes: p.notes ?? "",
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      if (editing) {
        await update.mutateAsync({ ...form, needsReview: false });
        toast.success("Billing account updated");
      } else {
        await create.mutateAsync(form);
        toast.success("Billing account created");
      }
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save billing account");
    }
  };

  const toggleActive = async (p: Payer) => {
    setTogglingId(p.id);
    try {
      const res = await fetch(`/api/billing-accounts/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Request failed");
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts });
      toast.success(p.isActive ? "Deactivated" : "Reactivated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update status");
    } finally {
      setTogglingId(null);
    }
  };

  const saving = create.isPending || update.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              Billing Accounts
            </CardTitle>
            <CardDescription>
              Reusable third-party payers for &quot;charge to another account&quot; —
              a doctor&apos;s hospital, or a company/grant covering specific
              attendees. Selectable when adding or editing a registration.
            </CardDescription>
          </div>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 mr-1.5" /> Add Payer
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No billing accounts yet. Add one to bill a registration to an
            institution or company instead of the attendee.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>VAT / Tax No.</TableHead>
                <TableHead className="text-center">Events</TableHead>
                <TableHead className="text-center">Registrations</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="w-10" />
                <TableHead className="w-10" />
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(accounts as Payer[]).map((p) => (
                <TableRow key={p.id} className={p.isActive ? "" : "opacity-60"}>
                  <TableCell className="font-medium">
                    {p.name}
                    {p.needsReview && (
                      <Badge variant="destructive" className="ml-2">Needs review</Badge>
                    )}
                  </TableCell>
                  <TableCell>{p.type}</TableCell>
                  <TableCell>{p.taxNumber || "—"}</TableCell>
                  <TableCell className="text-center">
                    <button
                      onClick={() => setEventsDialogFor(p)}
                      className="text-xs underline text-muted-foreground hover:text-foreground"
                      title="Manage which events this payer is available in"
                    >
                      {p._count?.events ?? 0}
                    </button>
                  </TableCell>
                  <TableCell className="text-center">{p._count?.registrations ?? 0}</TableCell>
                  <TableCell className="text-center">
                    <button
                      onClick={() => toggleActive(p)}
                      disabled={togglingId === p.id}
                      className="text-xs underline text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {p.isActive ? "Active" : "Inactive"}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => setEventsDialogFor(p)} title="Manage events">
                      <CalendarDays className="h-4 w-4" />
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setMergeDialogFor(p)}
                      title="Merge this payer into another (moves its registrations + events, then deletes it)"
                    >
                      <GitMerge className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <EventsAttachmentDialog
        payer={eventsDialogFor}
        onClose={() => setEventsDialogFor(null)}
      />

      <MergePayerDialog
        duplicate={mergeDialogFor}
        accounts={accounts as Payer[]}
        onClose={() => setMergeDialogFor(null)}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit billing account" : "Add billing account"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="ba-name">Name *</Label>
              <Input id="ba-name" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Cleveland Clinic / Pfizer MENA" />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v as Payer["type"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="INSTITUTION">Institution / Hospital</SelectItem>
                  <SelectItem value="COMPANY">Company / Pharma</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-tax">VAT / Tax Number</Label>
              <Input id="ba-tax" value={form.taxNumber}
                onChange={(e) => setForm({ ...form, taxNumber: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-contact">AP Contact Name</Label>
              <Input id="ba-contact" value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-email">Billing Email</Label>
              <Input id="ba-email" type="email" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-phone">Phone</Label>
              <Input id="ba-phone" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="ba-address">Address</Label>
              <Input id="ba-address" value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-city">City</Label>
              <Input id="ba-city" value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-country">Country</Label>
              <Input id="ba-country" value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-state">State</Label>
              <Input id="ba-state" value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-zip">Zip / Postal Code</Label>
              <Input id="ba-zip" value={form.zipCode}
                onChange={(e) => setForm({ ...form, zipCode: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="ba-notes">Internal Notes</Label>
              <Textarea id="ba-notes" rows={2} value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Attach a BillingAccount to one or more events via the per-event
 * junction. The payer is only selectable on an event's Add Registration
 * picker once it's been attached here. Idempotent on both POST and
 * DELETE so a rapid toggle won't 4xx; we invalidate the org-wide
 * billingAccounts query so the row's "Events" count refreshes
 * immediately.
 */
/**
 * Merge a duplicate payer into a survivor — the review action for
 * `needsReview` rows (near-duplicate names minted by inline payer create).
 * The picked SURVIVOR keeps its details; the duplicate's registrations +
 * event attachments are re-pointed to it in one transaction, then the
 * duplicate is deleted. Irreversible, so the dialog spells that out.
 */
function MergePayerDialog({
  duplicate,
  accounts,
  onClose,
}: {
  duplicate: Payer | null;
  accounts: Payer[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [survivorId, setSurvivorId] = useState("");
  const [merging, setMerging] = useState(false);
  // Reset the picked survivor whenever a different duplicate opens the dialog
  // (render-time sync — no effect).
  const [prevDuplicateId, setPrevDuplicateId] = useState<string | null>(null);
  if ((duplicate?.id ?? null) !== prevDuplicateId) {
    setPrevDuplicateId(duplicate?.id ?? null);
    setSurvivorId("");
  }

  const candidates = accounts.filter((a) => a.id !== duplicate?.id);

  const merge = async () => {
    if (!duplicate || !survivorId) return;
    setMerging(true);
    try {
      const res = await fetch(`/api/billing-accounts/${survivorId}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duplicateId: duplicate.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Merge failed");
      await queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts });
      toast.success(
        `Merged "${duplicate.name}" — ${data.registrationsRepointed ?? 0} registration(s) and ${data.eventsRepointed ?? 0} event attachment(s) moved.`,
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  return (
    <Dialog open={!!duplicate} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge {duplicate?.name ?? "payer"} into…</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Every registration billed to <span className="font-medium">{duplicate?.name}</span> and
          every event it&apos;s attached to will move to the payer you pick below, then{" "}
          <span className="font-medium">{duplicate?.name}</span> is deleted. The surviving
          payer&apos;s details (address, VAT number, contacts) are kept as-is. This cannot be
          undone.
        </p>
        <div className="space-y-2">
          <Label>Surviving payer</Label>
          <Select value={survivorId} onValueChange={setSurvivorId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick the payer to keep" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} ({a.type}){a.isActive ? "" : " — inactive"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {candidates.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No other payers to merge into — add the canonical payer first.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={merging}>Cancel</Button>
          <Button onClick={merge} disabled={!survivorId || merging} variant="destructive">
            {merging ? "Merging…" : "Merge & delete duplicate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventsAttachmentDialog({
  payer,
  onClose,
}: {
  payer: Payer | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: detail, isLoading: loadingDetail } = useBillingAccount(payer?.id ?? "") as {
    data: PayerDetail | undefined;
    isLoading: boolean;
  };
  const { data: events = [], isLoading: loadingEvents } = useEvents() as {
    data: EventRow[];
    isLoading: boolean;
  };
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);

  const attachedIds = new Set(
    (detail?.attachedEvents ?? []).map((a) => a.eventId),
  );

  const toggle = async (eventId: string, isAttached: boolean) => {
    if (!payer) return;
    setPendingEventId(eventId);
    try {
      const res = await fetch(
        `/api/events/${eventId}/billing-accounts/${payer.id}`,
        { method: isAttached ? "DELETE" : "POST" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Request failed");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billingAccount(payer.id) }),
      ]);
      toast.success(
        isAttached
          ? `Removed from "${events.find((e) => e.id === eventId)?.name ?? "event"}"`
          : `Attached to "${events.find((e) => e.id === eventId)?.name ?? "event"}"`,
      );
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to update event attachment",
      );
    } finally {
      setPendingEventId(null);
    }
  };

  return (
    <Dialog open={!!payer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Events using {payer?.name ?? "this payer"}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Check the events where this payer should be selectable on Add
          Registration. A payer can be attached to many events — it&apos;s
          the same logical row, just made available per event.
        </p>
        {loadingDetail || loadingEvents ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No events in this organization yet.
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto divide-y border rounded-md">
            {events.map((ev) => {
              const isAttached = attachedIds.has(ev.id);
              const busy = pendingEventId === ev.id;
              return (
                <label
                  key={ev.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 hover:bg-accent/40 cursor-pointer",
                    busy && "opacity-50 pointer-events-none",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isAttached}
                    disabled={busy}
                    onChange={() => toggle(ev.id, isAttached)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{ev.name}</div>
                    {ev.startDate && (
                      <div className="text-xs text-muted-foreground">
                        {new Date(ev.startDate).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                  {isAttached && <Badge variant="secondary">Attached</Badge>}
                </label>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
