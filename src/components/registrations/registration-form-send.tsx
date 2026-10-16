"use client";

/**
 * Sending personal registration form links at a chosen rate
 * (docs/REGISTRATION_FORM_LINKS_PLAN.md, Oct 16, 2026).
 *
 * `RegistrationFormFields` is the rate, sponsor and link-lifetime choice; the
 * Communications bulk email dialog and `SendRegistrationFormDialog` (the
 * Registrations list and the registration sheet) both render it, so the three
 * places ask the same thing the same way. The rules are server-side
 * (registration-form-service); this only collects the choice and warns.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEvent, useSendCompletionEmails, useSponsors, useTickets } from "@/hooks/use-api";
import { orderedTierNames, registerTierSlug } from "@/lib/main-register-tiers";
import { readCodeRequiredTiers } from "@/lib/code-required-tiers";
import {
  DAY_MS,
  DEFAULT_LINK_EXPIRY_DAYS,
  MAX_LINK_EXPIRY_DAYS,
  MIN_LINK_EXPIRY_DAYS,
  parseLinkExpiryInput,
} from "@/lib/link-expiry";
import { COMPLIMENTARY_RATE, REGISTRATION_FORM_SKIP_LABELS, type RegistrationFormSkipReason } from "@/lib/registration-form-link";

/** Use the sponsor already on each registration (e.g. from the CSV). */
const SPONSOR_FROM_REGISTRATION = "__registration__";

export interface RegistrationFormChoice {
  /** A rate-name slug or "complimentary"; empty until chosen. */
  rate: string;
  sponsorId: string;
  /** What the organiser typed, digits only. */
  expiryDays: string;
}

export const EMPTY_REGISTRATION_FORM_CHOICE: RegistrationFormChoice = {
  rate: "",
  sponsorId: SPONSOR_FROM_REGISTRATION,
  expiryDays: String(DEFAULT_LINK_EXPIRY_DAYS),
};

interface TierRow {
  name: string;
  isActive?: boolean;
  salesStart?: string | null;
  salesEnd?: string | null;
  sortOrder?: number | null;
}
interface TypeRow {
  isFaculty?: boolean;
  pricingTiers?: TierRow[] | null;
}

/** What the server needs, or the reason the choice is not complete. */
export function registrationFormPayload(
  choice: RegistrationFormChoice,
): { ok: true; rate: string; sponsorId?: string; expiryDays: number } | { ok: false; error: string } {
  if (!choice.rate) return { ok: false, error: "Choose the rate the links carry." };
  const expiryDays = parseLinkExpiryInput(choice.expiryDays);
  if (expiryDays === null) {
    return { ok: false, error: `Enter how many days the links stay valid: a whole number from ${MIN_LINK_EXPIRY_DAYS} to ${MAX_LINK_EXPIRY_DAYS}.` };
  }
  const sponsorId = choice.sponsorId === SPONSOR_FROM_REGISTRATION ? undefined : choice.sponsorId;
  return { ok: true, rate: choice.rate, sponsorId, expiryDays };
}

/**
 * When the chosen rate stops selling before the links expire, the links stop
 * working then (owner D3: a closed rate is refused). Null when that is not so.
 */
function closingWarning(types: TypeRow[], rate: string, expiryDays: number | null): string | null {
  if (!rate || rate === COMPLIMENTARY_RATE) return null;
  const now = Date.now();
  const matching = types.flatMap((t) => t.pricingTiers ?? []).filter((t) => registerTierSlug(t.name) === rate);
  const open = matching.filter(
    (t) => t.isActive !== false
      && (!t.salesStart || new Date(t.salesStart).getTime() <= now)
      && (!t.salesEnd || new Date(t.salesEnd).getTime() > now),
  );
  const name = matching[0]?.name ?? rate;
  if (open.length === 0) return `${name} is not on sale right now, so these people would be skipped.`;
  const ends = open.map((t) => (t.salesEnd ? new Date(t.salesEnd).getTime() : Infinity));
  const firstEnd = Math.min(...ends);
  if (expiryDays === null || firstEnd === Infinity || firstEnd >= now + expiryDays * DAY_MS) return null;
  const date = new Date(firstEnd).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${name} closes on ${date}, so these links stop working then, even though they are valid for ${expiryDays} days.`;
}

export function RegistrationFormFields({
  eventId,
  value,
  onChange,
  idPrefix = "registration-form",
}: {
  eventId: string;
  value: RegistrationFormChoice;
  onChange: (next: RegistrationFormChoice) => void;
  idPrefix?: string;
}) {
  const { data: ticketTypes = [] } = useTickets(eventId);
  const { data: event } = useEvent(eventId);
  const sponsorLinks = readCodeRequiredTiers(event?.settings);
  const sponsorRate = !!value.rate && sponsorLinks.includes(value.rate);
  const { data: sponsorData } = useSponsors(eventId, sponsorRate);

  const types = (ticketTypes as TypeRow[]).filter((t) => !t.isFaculty);
  const rates = orderedTierNames(types);
  const warning = closingWarning(types, value.rate, parseLinkExpiryInput(value.expiryDays));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-rate`}>Rate</Label>
        <Select value={value.rate} onValueChange={(rate) => onChange({ ...value, rate })}>
          <SelectTrigger id={`${idPrefix}-rate`} className="w-full">
            <SelectValue placeholder="Choose the rate" />
          </SelectTrigger>
          <SelectContent>
            {rates.map(({ slug, name }) => (
              <SelectItem key={slug} value={slug}>
                {sponsorLinks.includes(slug) ? `${name} (sponsor link)` : name}
              </SelectItem>
            ))}
            <SelectItem value={COMPLIMENTARY_RATE}>Complimentary (no charge)</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Set on each registration now, so the price shows straight away. People can change their
          registration type on the form, at the same rate.
        </p>
      </div>

      {sponsorRate && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-sponsor`}>Sponsor</Label>
          <Select value={value.sponsorId} onValueChange={(sponsorId) => onChange({ ...value, sponsorId })}>
            <SelectTrigger id={`${idPrefix}-sponsor`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SPONSOR_FROM_REGISTRATION}>The sponsor already on each registration</SelectItem>
              {(sponsorData?.sponsors ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            They are registered as covered by this sponsor, with nothing to pay. Anyone with no sponsor is skipped.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-expiry`}>Link valid for (days)</Label>
        <Input
          id={`${idPrefix}-expiry`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={3}
          className="w-32"
          value={value.expiryDays}
          onChange={(e) => onChange({ ...value, expiryDays: e.target.value.replace(/\D/g, "") })}
          aria-invalid={parseLinkExpiryInput(value.expiryDays) === null}
        />
        <p className="text-xs text-muted-foreground">
          Each person&apos;s link stops working after this many days, for example 10 or 30. Whole numbers
          from {MIN_LINK_EXPIRY_DAYS} to {MAX_LINK_EXPIRY_DAYS}.
        </p>
      </div>

      {warning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
    </div>
  );
}

/** "Skipped 2: already completed (1), already paid or invoiced (1)." */
function skipSummary(details: { reason: RegistrationFormSkipReason }[]): string {
  const counts = new Map<string, number>();
  for (const d of details) {
    const label = REGISTRATION_FORM_SKIP_LABELS[d.reason] ?? d.reason;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} (${n})`).join(", ");
}

/** The Send Registration Form confirm dialog: the Registrations list and the registration sheet. */
export function SendRegistrationFormDialog({
  eventId,
  open,
  onOpenChange,
  registrationIds,
  recipientLabel,
  onSent,
}: {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registrationIds: string[];
  /** "Ann Lee (ann@x.com)" for one person, or "12 registrants". */
  recipientLabel: string;
  onSent?: () => void;
}) {
  const send = useSendCompletionEmails(eventId);
  const [choice, setChoice] = useState<RegistrationFormChoice>(EMPTY_REGISTRATION_FORM_CHOICE);
  const payload = useMemo(() => registrationFormPayload(choice), [choice]);

  // Start from a clean choice every time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setChoice(EMPTY_REGISTRATION_FORM_CHOICE);
  }

  const submit = async () => {
    if (!payload.ok) {
      toast.error(payload.error);
      return;
    }
    try {
      const result = await send.mutateAsync({ registrationIds, ...payload });
      onOpenChange(false);
      onSent?.();
      toast.success(`Sent ${result.sent} registration form${result.sent === 1 ? "" : "s"} at ${result.rateName}.`);
      if (result.skipped > 0) {
        toast.warning(`Skipped ${result.skipped}: ${skipSummary(result.skippedDetails ?? [])}.`, { duration: 10_000 });
      }
      if (result.errors.length > 0) {
        console.error("send-registration-form: delivery errors", result.errors);
        toast.error(`${result.errors.length} could not be delivered: ${result.errors.slice(0, 3).join("; ")}`);
      }
    } catch (err) {
      console.error("send-registration-form: failed", err);
      toast.error(err instanceof Error ? err.message : "Send failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <DialogHeader>
          <DialogTitle>Send registration form</DialogTitle>
          <DialogDescription>
            Each person gets an email with their own link to complete their registration at the rate you
            choose. People who already completed, have paid or been invoiced, are in a group, or whose
            registration type has no such rate are skipped, and you are told why.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex-1 space-y-4 overflow-y-auto px-1">
          <p className="text-sm text-muted-foreground">
            Sending to <span className="font-medium text-foreground">{recipientLabel}</span>. Counts against the
            5-per-hour send limit.
          </p>
          <RegistrationFormFields eventId={eventId} value={choice} onChange={setChoice} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={send.isPending || registrationIds.length === 0 || !payload.ok}>
            {send.isPending ? "Sending..." : `Send to ${registrationIds.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
