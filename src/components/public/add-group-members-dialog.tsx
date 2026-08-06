"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, AlertCircle } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { TitleSelect } from "@/components/ui/title-select";
import { CountrySelect } from "@/components/ui/country-select";
import {
  livePrice, purchasableTypes, type PublicTicketType,
} from "@/lib/public-ticket-price";

/**
 * "Add people" for the My Group portal.
 *
 * Deliberately shows the coordinator what the addition will COST and how it
 * will be billed BEFORE they submit, because the two cases differ in a way
 * that matters to their finance team: an unpaid invoice is replaced, while a
 * settled one is left alone and the new arrivals get their own.
 *
 * Prices shown here come from the same helper the group registration form
 * uses, so the same person can't be quoted two different prices. They are
 * indicative only — the server resolves the real price at submission, so a
 * page left open across a tier change cannot lock in a stale rate.
 */

interface MemberForm {
  ticketTypeId: string;
  title: string;
  firstName: string;
  lastName: string;
  email: string;
  organization: string;
  jobTitle: string;
  phone: string;
  city: string;
  country: string;
}

const EMPTY: MemberForm = {
  ticketTypeId: "", title: "", firstName: "", lastName: "", email: "",
  organization: "", jobTitle: "", phone: "", city: "", country: "",
};

export interface AddGroupMembersResultShape {
  addedCount: number;
  invoiceNumber: string | null;
  reissued: boolean;
}

export function AddGroupMembersDialog({
  open,
  onOpenChange,
  slug,
  groupId,
  currency,
  remainingSlots,
  groupIsPaid,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  groupId: string;
  currency: string;
  /** Places left before the event's group cap; null when uncapped. */
  remainingSlots: number | null;
  groupIsPaid: boolean;
  onAdded: (result: AddGroupMembersResultShape) => void;
}) {
  const [types, setTypes] = useState<PublicTicketType[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [typesError, setTypesError] = useState(false);
  const [members, setMembers] = useState<MemberForm[]>([{ ...EMPTY }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on every closed → open transition, so a previous attempt's rows and
  // error never bleed into a fresh one.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMembers([{ ...EMPTY }]);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingTypes(true);
    setTypesError(false);
    (async () => {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setTypes(purchasableTypes(data.ticketTypes ?? []));
      } catch {
        // Without types there is nothing to choose, so this must be visible
        // rather than presenting an empty dropdown as if nothing were on sale.
        if (!cancelled) setTypesError(true);
      } finally {
        if (!cancelled) setLoadingTypes(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, slug]);

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  const estimatedTotal = useMemo(
    () =>
      members.reduce((sum, m) => {
        const t = m.ticketTypeId ? typeById.get(m.ticketTypeId) : undefined;
        return t ? sum + livePrice(t).price : sum;
      }, 0),
    [members, typeById],
  );

  const atCap = remainingSlots !== null && members.length >= remainingSlots;

  const update = (i: number, patch: Partial<MemberForm>) =>
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));

  const canSubmit =
    !submitting &&
    members.length > 0 &&
    members.every(
      (m) => m.ticketTypeId && m.firstName.trim() && m.lastName.trim() && m.email.trim(),
    );

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/registrant/my-group/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          members: members.map((m) => ({
            ticketTypeId: m.ticketTypeId,
            attendee: {
              title: m.title || null,
              firstName: m.firstName.trim(),
              lastName: m.lastName.trim(),
              email: m.email.trim(),
              organization: m.organization || null,
              jobTitle: m.jobTitle || null,
              phone: m.phone || null,
              city: m.city || null,
              country: m.country || null,
            },
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || "We couldn't add these people. Please try again.");
        return;
      }
      onAdded(body as AddGroupMembersResultShape);
      onOpenChange(false);
    } catch {
      setError("Network problem — nobody was added. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add people to your group</DialogTitle>
          <DialogDescription asChild>
            <span className="text-sm text-slate-600">
              {groupIsPaid ? (
                <>
                  Your existing invoice is settled and won&apos;t change. These
                  people will be added to a separate invoice covering only them.
                </>
              ) : (
                <>
                  Your current invoice will be replaced by an updated one
                  covering everyone, including the people you add here.
                </>
              )}
            </span>
          </DialogDescription>
        </DialogHeader>

        {typesError ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              We couldn&apos;t load the registration types. Please close this and
              try again.
            </span>
          </div>
        ) : null}

        <div className="space-y-4">
          {members.map((m, i) => {
            const t = m.ticketTypeId ? typeById.get(m.ticketTypeId) : undefined;
            const p = t ? livePrice(t) : null;
            return (
              <div key={i} className="rounded-lg border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="text-sm font-medium text-slate-700">
                    Person {i + 1}
                  </h4>
                  {members.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setMembers((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Remove person {i + 1}</span>
                    </Button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label className="mb-1 block text-xs">Registration type *</Label>
                    <Select
                      value={m.ticketTypeId}
                      onValueChange={(v) => update(i, { ticketTypeId: v })}
                      disabled={loadingTypes || types.length === 0}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={loadingTypes ? "Loading…" : "Choose a type"}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {types.map((tt) => {
                          const lp = livePrice(tt);
                          return (
                            <SelectItem key={tt.id} value={tt.id}>
                              {tt.name}
                              {lp.tierName ? ` (${lp.tierName})` : ""} —{" "}
                              {tt.currency ?? currency} {lp.price.toFixed(2)}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    {p && (
                      <p className="mt-1 text-xs text-slate-500">
                        {currency} {p.price.toFixed(2)}
                        {p.tierName ? ` · ${p.tierName}` : ""}
                      </p>
                    )}
                  </div>

                  <div>
                    <Label className="mb-1 block text-xs">Title</Label>
                    <TitleSelect
                      value={m.title}
                      onChange={(v) => update(i, { title: v })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">First name *</Label>
                    <Input
                      value={m.firstName}
                      onChange={(e) => update(i, { firstName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">Last name *</Label>
                    <Input
                      value={m.lastName}
                      onChange={(e) => update(i, { lastName: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">Email *</Label>
                    <Input
                      type="email"
                      value={m.email}
                      onChange={(e) => update(i, { email: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">Organization</Label>
                    <Input
                      value={m.organization}
                      onChange={(e) => update(i, { organization: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">Job title</Label>
                    <Input
                      value={m.jobTitle}
                      onChange={(e) => update(i, { jobTitle: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">Phone</Label>
                    <Input
                      value={m.phone}
                      onChange={(e) => update(i, { phone: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs">City</Label>
                    <Input
                      value={m.city}
                      onChange={(e) => update(i, { city: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="mb-1 block text-xs">Country</Label>
                    <CountrySelect
                      value={m.country}
                      onChange={(v) => update(i, { country: v })}
                    />
                  </div>
                </div>
              </div>
            );
          })}

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={atCap}
              onClick={() => setMembers((prev) => [...prev, { ...EMPTY }])}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add another person
            </Button>
            {atCap && (
              <p className="text-xs text-amber-700">
                That&apos;s the most your group can hold.
              </p>
            )}
          </div>

          {estimatedTotal > 0 && (
            <div className="rounded-lg border bg-slate-50 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">
                  Estimated for {members.length}{" "}
                  {members.length === 1 ? "person" : "people"}
                </span>
                <span className="font-semibold tabular-nums">
                  {currency} {estimatedTotal.toFixed(2)}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Before tax. Your invoice shows the final amount.
              </p>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {submitting
              ? "Adding…"
              : `Add ${members.length} ${members.length === 1 ? "person" : "people"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
