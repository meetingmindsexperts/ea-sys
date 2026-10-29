"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Banknote, CheckCircle2, Clock, Loader2, Pencil, Printer, QrCode, Search, Smartphone, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTickets, queryKeys, fetchApi } from "@/hooks/use-api";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { formatPersonName } from "@/lib/utils";
import { deskEnterAction, deskQueryIsSearchable, matchesDeskSearch } from "@/lib/desk-enter";
import { CompleteOnsiteDialog, EditDetailsDialog, useWaitingList, type OnsiteLink, type OnsitePerson } from "./desk-onsite";
import { WalkInQrDialog } from "./desk-walkin-qr";
import { useCan } from "@/hooks/use-can";
import { asksForIdentityEvidence, missingIdentityEvidence, readIdentityEvidencePolicy } from "@/lib/identity-evidence";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { CountrySelect } from "@/components/ui/country-select";
import { SupportingDocumentField, type UploadedDocument } from "@/components/public/registration-form-extras";

/**
 * The onsite desk (docs/ONSITE_DESK_PLAN.md §4): find someone and check them
 * in, or register a walk-in and take the money, in one step. Badges print only
 * when staff press Print badge (owner, Oct 29 2026: not by default), through
 * the browser's print dialog.
 */

interface DeskRegistration {
  id: string;
  serialId: number | null;
  status: string;
  paymentStatus: string;
  userId: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  attendee: {
    title?: string | null;
    firstName: string;
    lastName: string;
    email: string;
    organization?: string | null;
    jobTitle?: string | null;
    country?: string | null;
  };
  ticketType: { name: string; price?: number | string; currency?: string } | null;
  pricingTier?: { price: number | string; currency?: string } | null;
  originalPrice?: number | string | null;
  discountAmount?: number | string | null;
  /** Badges printed so far: the row offers Print badge, then Reprint badge. */
  badgePrintCount?: number;
  payments?: Array<{ amount: number | string; currency: string; status: string }>;
}

/** The event's tax, so the desk shows what to collect rather than the pre-tax price. */
interface DeskTax {
  taxRate: number | null;
  taxLabel: string | null;
}

interface DeskTier {
  id: string;
  name: string;
  price: number | string;
  currency: string;
  isActive: boolean;
  salesStart?: string | null;
  salesEnd?: string | null;
}

interface DeskTicketType {
  id: string;
  name: string;
  price: number | string;
  currency: string;
  isActive?: boolean;
  isFaculty?: boolean;
  pricingTiers?: DeskTier[];
  requiresMemberId?: boolean;
  requiresStudentId?: boolean;
  requiresStudentIdExpiry?: boolean;
  requiresDocument?: boolean;
  documentRequired?: boolean;
  documentLabel?: string | null;
  documentInstructions?: string | null;
}

type PaymentChoice = "complimentary" | "cash" | "card" | "inclusive";
/** What the walk-in route is told: a choice, or "covered" when a code leaves nothing to pay. */
type SubmittedPayment = PaymentChoice | "covered";

const PAYMENT_LABEL: Record<PaymentChoice, string> = {
  complimentary: "Complimentary",
  cash: "Cash",
  card: "Card",
  inclusive: "Sponsor (Inclusive)",
};

/** The desk's code check (walk-in/promo route): what to collect, or which sponsor pays. */
interface PromoPreview {
  /** The type, rate and code it was checked for; any other inputs make it stale. */
  key: string;
  code: string;
  discountType: string;
  discountValue: number;
  discountAmount: number;
  finalPrice: number;
  sponsorName: string | null;
}
const MAX_RESULTS = 8;
const OUTSTANDING = new Set(["UNASSIGNED", "UNPAID", "PENDING", "FAILED"]);

/**
 * Print one badge: the PDF loads in a hidden frame and the browser's print
 * dialog opens over the page. Returns the refusal message, or null when the
 * dialog was opened.
 */
async function printBadge(eventId: string, registrationId: string): Promise<string | null> {
  try {
    return await openBadgePrint(eventId, registrationId);
  } catch (err) {
    // Never thrown to the caller: the check-in already landed, and a thrown
    // error would read "NOT checked in" and invite a second check-in.
    console.error("[desk] badge print failed", err);
    return "network error";
  }
}

async function openBadgePrint(eventId: string, registrationId: string): Promise<string | null> {
  const res = await fetch(`/api/events/${eventId}/registrations/badges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationIds: [registrationId] }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error || "Badge generation failed";
  }
  const url = URL.createObjectURL(await res.blob());
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = url;
  frame.onload = () => frame.contentWindow?.print();
  document.body.appendChild(frame);
  // The print dialog reads the frame after load; clean up well after it closes.
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 120_000);
  return null;
}

/**
 * Whether the row owes money, so the desk offers Record payment first instead
 * of a check-in the door would refuse. The price is the same order the server
 * reads (stamped price, then tier, then type); the server gate still decides.
 */
function paymentDue(r: DeskRegistration): boolean {
  if (!OUTSTANDING.has(r.paymentStatus)) return false;
  return readRegistrationBasePrice(r) > 0;
}

/**
 * What is left to collect on a row, tax included and settled payments taken
 * off: the figure the desk shows and sends as the amount, so the payment, the
 * invoice and the receipt match the cash in hand (review of 26c17807, MED 3).
 */
function balanceToCollect(r: DeskRegistration, tax: DeskTax): { amount: number; currency: string } {
  const currency = (r.pricingTier?.currency ?? r.ticketType?.currency ?? "USD").toUpperCase();
  const totalPaid = (r.payments ?? [])
    .filter((p) => p.status === "PAID" && p.currency.toUpperCase() === currency)
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const fin = computeRegistrationFinancials({
    subtotal: readRegistrationBasePrice(r),
    discount: Number(r.discountAmount ?? 0),
    taxRate: tax.taxRate,
    taxLabel: tax.taxLabel,
    currency,
    totalPaid,
  });
  return { amount: fin.balanceDue, currency };
}

/** A walk-in's total to collect at a rate, after any code, tax included. */
function walkInTotal(price: number, currency: string, tax: DeskTax, discount = 0): number {
  return computeRegistrationFinancials({ subtotal: price, discount, taxRate: tax.taxRate, taxLabel: tax.taxLabel, currency }).total;
}

/** "20% off" or "USD 50.00 off". */
function discountLabel(p: PromoPreview, currency: string): string {
  return p.discountType === "PERCENTAGE" ? `${p.discountValue}% off` : `${currency} ${p.discountValue.toFixed(2)} off`;
}

/**
 * What the walk-in route is told. A cash or card code that leaves nothing to
 * pay goes as "covered": nothing is collected, so no payment is recorded and
 * no payment right is needed.
 */
function submittedPayment(choice: PaymentChoice, promo: PromoPreview | null): SubmittedPayment {
  if ((choice === "cash" || choice === "card") && promo?.finalPrice === 0) return "covered";
  return choice;
}

function promoKey(ticketTypeId: string, pricingTierId: string | null | undefined, code: string): string {
  return [ticketTypeId, pricingTierId ?? "", code.trim().toUpperCase()].join("|");
}

function personOf(r: DeskRegistration): OnsitePerson {
  return {
    id: r.id,
    name: formatPersonName(r.attendee.title, r.attendee.firstName, r.attendee.lastName),
    email: r.attendee.email,
    typeName: r.ticketType?.name ?? null,
  };
}

function isFormCompleted(r: DeskRegistration): boolean {
  return Boolean(r.completedAt || r.userId);
}

function StatusChips({ r }: { r: DeskRegistration }) {
  if (r.status === "CANCELLED") return <Badge variant="outline" className="text-red-700 border-red-200">Cancelled</Badge>;
  return (
    <>
      {r.status === "CHECKED_IN" && <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Checked in</Badge>}
      {!isFormCompleted(r) && <Badge variant="outline" className="text-amber-700 border-amber-200">Form not completed</Badge>}
      {paymentDue(r) && <Badge variant="outline" className="text-red-700 border-red-200">Payment due</Badge>}
    </>
  );
}

/** "AED 525.00 incl. VAT": what the desk collects. */
function collectLabel({ amount, currency }: { amount: number; currency: string }, tax: DeskTax): string {
  const taxed = Number(tax.taxRate ?? 0) > 0;
  return `${currency} ${amount.toFixed(2)}${taxed ? ` incl. ${tax.taxLabel || "VAT"}` : ""}`;
}

function money(amount: number | string, currency: string): string {
  const n = Number(amount);
  return n === 0 ? "Free" : `${currency} ${n.toFixed(2)}`;
}

/** The rate on sale right now, else the last active one (an onsite rate is usually last). */
function defaultTierId(tiers: DeskTier[]): string | null {
  const now = Date.now();
  const open = tiers.find(
    (t) => (!t.salesStart || Date.parse(t.salesStart) <= now) && (!t.salesEnd || Date.parse(t.salesEnd) >= now),
  );
  return (open ?? tiers[tiers.length - 1])?.id ?? null;
}

function readRemembered(eventId: string): { ticketTypeId?: string; pricingTierId?: string | null; payment?: PaymentChoice } {
  try {
    return JSON.parse(localStorage.getItem(`desk-walk-in:${eventId}`) || "{}");
  } catch {
    return {};
  }
}

function remember(eventId: string, value: { ticketTypeId: string; pricingTierId: string | null; payment: PaymentChoice }) {
  try {
    localStorage.setItem(`desk-walk-in:${eventId}`, JSON.stringify(value));
  } catch {
    // Private window or blocked storage: the desk just picks again.
  }
}

export function DeskPanel({
  eventId,
  eventSlug,
  tax,
  registrations,
}: {
  eventId: string;
  eventSlug: string;
  tax: DeskTax;
  registrations: DeskRegistration[];
}) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const operatorName = [session?.user?.firstName, session?.user?.lastName].filter(Boolean).join(" ") || "Registration desk";

  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payMethod, setPayMethod] = useState<"cash" | "card">("cash");
  const [payLast4, setPayLast4] = useState("");
  const [scanning, setScanning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [onsitePerson, setOnsitePerson] = useState<OnsitePerson | null>(null);
  const [editing, setEditing] = useState<DeskRegistration | null>(null);
  // The link each person was given at this desk, kept in memory so reopening
  // their window shows it again instead of revoking it (review of cf9775fd).
  const onsiteLinks = useRef(new Map<string, OnsiteLink>());
  // Edit only for those who may (a custom role may hold check-in without it).
  const canEdit = useCan("registrations.update", eventId) === "allowed";
  // The badges route needs its own key; without it the row offers no Print badge.
  const canPrint = useCan("registrations.badges.print", eventId) === "allowed";
  // Showing the walk-in QR lets people register themselves: the walk-in's key.
  const canRegister = useCan("registrations.create", eventId) === "allowed";
  const [qrOpen, setQrOpen] = useState(false);

  // One payment panel at a time, and it starts clean: a second row must not
  // inherit the first row's card digits (review of 26c17807, LOW 8).
  const openPayment = (id: string | null) => {
    setPayingId(id);
    setPayMethod("cash");
    setPayLast4("");
  };

  const results = useMemo(() => {
    if (!deskQueryIsSearchable(query)) return [];
    return registrations.filter((r) => matchesDeskSearch(r, query)).slice(0, MAX_RESULTS);
  }, [registrations, query]);

  // Not invalidateQueries: the list is served with stale-while-revalidate=30, so
  // for 30 s the browser answers a refetch with the old list and the person the
  // desk just admitted is missing. Bypass the HTTP cache and write the result in.
  const refresh = async () => {
    try {
      // fetchApi, so the org header an operator switching organisations needs goes too.
      const rows = await fetchApi<unknown[]>(`/api/events/${eventId}/registrations`, { cache: "no-store" });
      queryClient.setQueryData(queryKeys.registrations(eventId), rows);
    } catch (err) {
      console.error("[desk] list refresh failed", err);
      await queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    }
  };

  // People completing their form onsite, polled until they finish (§5.1).
  const waiting = useWaitingList(eventId, refresh);
  const { entries: waitingEntries, remove: removeWaiting } = waiting;
  // Admitted people leave the list.
  useEffect(() => {
    for (const entry of waitingEntries) {
      if (registrations.find((r) => r.id === entry.id)?.status === "CHECKED_IN") removeWaiting(entry.id);
    }
  }, [registrations, waitingEntries, removeWaiting]);

  const onsiteRow = onsitePerson ? registrations.find((r) => r.id === onsitePerson.id) : undefined;
  const onsiteCompleted =
    !!onsitePerson && (!!waitingEntries.find((e) => e.id === onsitePerson.id)?.completed || (!!onsiteRow && isFormCompleted(onsiteRow)));

  const addWaiting = waiting.add;
  const onLinkCreated = useCallback(
    (person: OnsitePerson, link: OnsiteLink) => {
      onsiteLinks.current.set(person.id, link);
      addWaiting(person, link.expiresAt);
    },
    [addWaiting],
  );

  /** From the Complete onsite window, once their form is in: pay first when owed, then admit. */
  const admitOnsite = () => {
    const row = onsiteRow;
    setOnsitePerson(null);
    if (!row) return;
    setQuery(row.attendee.email);
    if (paymentDue(row)) {
      openPayment(row.id);
      return;
    }
    checkIn(row);
  };

  // Check-in does not print (owner, Oct 29 2026): the row then offers Print badge.
  const checkIn = async (r: DeskRegistration) => {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${r.id}/check-in`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.code === "PAYMENT_REQUIRED") {
        openPayment(r.id);
        toast.warning("Payment is due. Record it, then they are checked in.");
        return;
      }
      if (!res.ok && data.code !== "ALREADY_CHECKED_IN") {
        toast.error(data.error || "Check-in failed");
        return;
      }
      toast.success(`${formatPersonName(r.attendee.title, r.attendee.firstName, r.attendee.lastName)} checked in`);
      refresh();
    } catch (err) {
      console.error("[desk] check-in failed", err);
      toast.error("Network error: NOT checked in. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  /** Print or reprint the badge, only on request. */
  const print = async (r: DeskRegistration) => {
    setBusyId(r.id);
    try {
      const refusal = await printBadge(eventId, r.id);
      if (refusal) toast.error(refusal);
      // The count moved, so the row now reads Reprint badge.
      else refresh();
    } catch (err) {
      console.error("[desk] badge print failed", err);
      toast.error("Network error: the badge did not print");
    } finally {
      setBusyId(null);
    }
  };

  const recordPaymentThenAdmit = async (r: DeskRegistration) => {
    if (payMethod === "card" && !/^\d{4}$/.test(payLast4)) {
      toast.error("Enter the last 4 digits of the card");
      return;
    }
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${r.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          {
            ...(payMethod === "card" ? { method: "card_onsite", cardLast4: payLast4 } : { method: "cash", cashReceivedBy: operatorName }),
            // The figure the desk showed and collected; the server audits any
            // difference from its own total.
            ...balanceToCollect(r, tax),
          },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "The payment was not recorded");
        return;
      }
      if (!data.fullyPaid) {
        toast.warning("Recorded, but it does not cover the total. Check the registration.");
        return;
      }
      openPayment(null);
    } catch (err) {
      console.error("[desk] payment failed", err);
      toast.error("Network error: the payment was NOT recorded");
      return;
    } finally {
      setBusyId(null);
    }
    await checkIn(r);
  };

  /**
   * Enter in the search box (the decision is `deskEnterAction`). A ref, not
   * state, guards against a second Enter: state lags a fast repeat or a
   * scanner's CR+LF, and a second run would check in twice.
   */
  const enterInFlight = useRef(false);
  // And a repeat on the same person within 2 s is ignored even after the first
  // finished (an operator's double tap), as the Check-In scanner does for codes.
  const lastEnter = useRef<{ id: string; at: number } | null>(null);
  const handleEnter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enterInFlight.current) return;
    const action = deskEnterAction(
      query,
      results.map((r) => ({ id: r.id, status: r.status, paymentDue: paymentDue(r) })),
    );
    const row = "id" in action ? results.find((r) => r.id === action.id) : undefined;
    if (row) {
      const last = lastEnter.current;
      if (last && last.id === row.id && Date.now() - last.at < 2000) return;
      lastEnter.current = { id: row.id, at: Date.now() };
    }
    enterInFlight.current = true;
    try {
      if (action.kind === "checked-in") toast.info("Already checked in. Print or reprint the badge from their row if they need one.");
      else if (action.kind === "check-in" && row) await checkIn(row);
      else if (action.kind === "pay") openPayment(action.id);
      else if (action.kind === "scan") await scanCode(action.code);
      else if (action.kind === "choose") toast.info(`${action.count} people match. Choose one.`);
      else if (action.kind === "cancelled") toast.info("This registration is cancelled.");
      else if (action.kind === "no-match") toast.info("Nobody matches. Check the spelling, scan the barcode, or register them as a walk-in.");
    } finally {
      enterInFlight.current = false;
    }
  };

  const scanCode = async (code: string) => {
    setScanning(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/_/check-in`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qrCode: code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`${formatPersonName(data.attendee?.title, data.attendee?.firstName ?? "", data.attendee?.lastName ?? "")} checked in`);
        // The box is cleared for the next badge in the queue: a scanner types
        // onto whatever is left there (review of a9557bc9). To print, search
        // their name; their row has Print badge.
        setQuery("");
        await refresh();
        return;
      }
      if (data.code === "ALREADY_CHECKED_IN" && data.registration?.attendee?.email) {
        toast.warning("Already checked in. Print or reprint the badge from their row if they need one.");
        setQuery(data.registration.attendee.email);
        return;
      }
      if (data.code === "PAYMENT_REQUIRED") {
        // The door names who it refused, so the desk can take the payment
        // straight away instead of asking for their name.
        const owing = registrations.find((r) => r.id === data.registrationId);
        if (!owing) {
          toast.warning("Payment is due. Search their name to record it.");
          return;
        }
        setQuery(owing.attendee.email);
        openPayment(owing.id);
        toast.warning("Payment is due. Record it, then they are checked in.");
        return;
      }
      toast.error(data.error || "No registration with that code");
    } catch (err) {
      console.error("[desk] scan failed", err);
      toast.error("Network error: NOT checked in. Scan again.");
    } finally {
      setScanning(false);
      searchRef.current?.focus();
      // Whatever a refusal left in the box (their email, the code) is selected
      // once it renders, so the next scan replaces it rather than appending.
      setTimeout(() => searchRef.current?.select(), 0);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardContent className="p-4 space-y-3">
          <form onSubmit={handleEnter} className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, email, organisation, registration number or scan"
              className="pl-10 pr-10 h-12 text-base"
              autoComplete="off"
              autoFocus
              // readOnly, not disabled: a disabled input loses focus, and the
              // next scan's keystrokes would land nowhere.
              readOnly={scanning}
            />
            {scanning && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
          </form>
          {!deskQueryIsSearchable(query) && (
            <p className="text-sm text-muted-foreground px-1">
              Type two letters of a name or a registration number, or scan a badge or confirmation barcode. Enter acts on a single match.
            </p>
          )}
          {deskQueryIsSearchable(query) && results.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">
              Nobody matches. Press Enter if this is a scanned code, or register them as a walk-in.
            </p>
          )}
          {waitingEntries.length > 0 && (
            <div className="space-y-1.5 rounded-md border bg-slate-50 p-2">
              <p className="px-1 text-xs font-medium text-muted-foreground">Waiting to complete their form</p>
              <div className="flex flex-wrap gap-1.5">
                {waitingEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setOnsitePerson(entry)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                      entry.completed ? "border-green-200 bg-green-50 text-green-800" : "bg-white text-slate-700"
                    }`}
                  >
                    {entry.completed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                    {entry.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2 empty:hidden">
            {results.map((r) => (
              <div key={r.id} className="rounded-lg border bg-white p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {formatPersonName(r.attendee.title, r.attendee.firstName, r.attendee.lastName)}
                      {r.serialId != null && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{String(r.serialId).padStart(3, "0")}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[r.attendee.email, r.attendee.organization].filter(Boolean).join(" · ")}
                    </p>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {r.ticketType && <Badge variant="outline">{r.ticketType.name}</Badge>}
                      <StatusChips r={r} />
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <RowAction
                      r={r}
                      busy={busyId === r.id}
                      onCheckIn={() => checkIn(r)}
                      onRecordPayment={() => openPayment(r.id)}
                      onPrint={canPrint ? () => print(r) : undefined}
                    />
                    {r.status !== "CANCELLED" && (
                      <div className="flex gap-1">
                        {!isFormCompleted(r) && (
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setOnsitePerson(personOf(r))}>
                            <Smartphone className="h-3.5 w-3.5" /> Complete onsite
                          </Button>
                        )}
                        {canEdit && (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setEditing(r)}>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {payingId === r.id && (
                  <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/50 p-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Paid by</Label>
                      <Select value={payMethod} onValueChange={(v) => v && setPayMethod(v as "cash" | "card")}>
                        <SelectTrigger className="w-28 h-9 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="card">Card</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {payMethod === "card" && (
                      <div className="space-y-1">
                        <Label className="text-xs" htmlFor={`last4-${r.id}`}>Card last 4</Label>
                        <Input
                          id={`last4-${r.id}`}
                          value={payLast4}
                          onChange={(e) => setPayLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                          inputMode="numeric"
                          className="w-24 h-9 bg-white"
                        />
                      </div>
                    )}
                    <Button size="sm" className="h-9" disabled={busyId === r.id} onClick={() => recordPaymentThenAdmit(r)}>
                      {`Record ${collectLabel(balanceToCollect(r, tax), tax)} & check in`}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-9" onClick={() => openPayment(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {canRegister && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold">
                <QrCode className="h-4 w-4 text-primary" /> Walk-in QR
              </p>
              <p className="text-xs text-muted-foreground">Exhibitors and complimentary guests register themselves on their phone.</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setQrOpen(true)}>Show QR</Button>
          </CardContent>
        </Card>
      )}

      <WalkInForm
        eventId={eventId}
        eventSlug={eventSlug}
        tax={tax}
        onRegistered={(email) => {
          setQuery(email);
          refresh();
        }}
        onDone={async (email) => {
          // Show the new row once the list has it: "Checked in", with Print
          // badge on it should they want one (not printed by default).
          await refresh();
          setQuery(email);
          searchRef.current?.focus();
        }}
      />

      <CompleteOnsiteDialog
        eventId={eventId}
        person={onsitePerson}
        completed={onsiteCompleted}
        cachedLink={onsitePerson ? onsiteLinks.current.get(onsitePerson.id) ?? null : null}
        onLinkCreated={onLinkCreated}
        onWatch={addWaiting}
        onAdmit={admitOnsite}
        onClose={() => {
          setOnsitePerson(null);
          searchRef.current?.focus();
        }}
      />
      <EditDetailsDialog eventId={eventId} person={editing} onSaved={refresh} onClose={() => setEditing(null)} />
      <WalkInQrDialog
        eventId={eventId}
        open={qrOpen}
        onClose={() => {
          setQrOpen(false);
          // Who registered meanwhile shows in search.
          refresh();
          searchRef.current?.focus();
        }}
      />
    </div>
  );
}

function RowAction({
  r,
  busy,
  onCheckIn,
  onRecordPayment,
  onPrint,
}: {
  r: DeskRegistration;
  busy: boolean;
  onCheckIn: () => void;
  onRecordPayment: () => void;
  /** Absent when the person may not print badges. */
  onPrint?: () => void;
}) {
  if (r.status === "CANCELLED") return null;
  if (busy) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground shrink-0" />;
  if (r.status === "CHECKED_IN") {
    if (!onPrint) return null;
    return (
      <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={onPrint}>
        <Printer className="h-4 w-4" /> {(r.badgePrintCount ?? 0) > 0 ? "Reprint badge" : "Print badge"}
      </Button>
    );
  }
  if (paymentDue(r)) {
    return (
      <Button size="sm" variant="outline" className="shrink-0 gap-1.5 border-red-200 text-red-700" onClick={onRecordPayment}>
        <Banknote className="h-4 w-4" /> Record payment
      </Button>
    );
  }
  return (
    <Button size="sm" className="shrink-0 gap-1.5" onClick={onCheckIn}>
      <CheckCircle2 className="h-4 w-4" /> Check in
    </Button>
  );
}

interface WalkInFields {
  title: string;
  firstName: string;
  lastName: string;
  email: string;
  additionalEmail: string;
  jobTitle: string;
  organization: string;
  phone: string;
  country: string;
  city: string;
  specialty: string;
  customSpecialty: string;
  role: string;
  associationName: string;
  memberId: string;
  studentId: string;
  studentIdExpiry: string;
  cardLast4: string;
}

const EMPTY_FIELDS: WalkInFields = {
  title: "",
  firstName: "",
  lastName: "",
  email: "",
  additionalEmail: "",
  jobTitle: "",
  organization: "",
  phone: "",
  country: "",
  city: "",
  specialty: "",
  customSpecialty: "",
  role: "",
  associationName: "",
  memberId: "",
  studentId: "",
  studentIdExpiry: "",
  cardLast4: "",
};

/** The public form's required fields that a plain input's `required` cannot catch (the pickers). */
const REQUIRED_PICKERS: Array<[keyof WalkInFields, string]> = [
  ["title", "Title"],
  ["country", "Country"],
  ["specialty", "Specialty"],
  ["role", "Role"],
];

function missingFields(fields: WalkInFields, type: DeskTicketType | undefined): string[] {
  const missing = REQUIRED_PICKERS.filter(([key]) => !fields[key].trim()).map(([, label]) => label);
  if (fields.specialty === "Others" && !fields.customSpecialty.trim()) missing.push("Specialty (please specify)");
  if (type) {
    missing.push(...missingIdentityEvidence(readIdentityEvidencePolicy(type), fields));
  }
  return missing;
}

function Field({ label, required, htmlFor, children, className }: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-red-500"> *</span>}
      </Label>
      {children}
    </div>
  );
}

function WalkInForm({
  eventId,
  eventSlug,
  tax,
  onRegistered,
  onDone,
}: {
  eventId: string;
  /** The upload field's public route needs it; the desk overrides it with its staff route. */
  eventSlug: string;
  tax: DeskTax;
  /** Registered, but a later step did not finish: show them in search. */
  onRegistered: (email: string) => void;
  onDone: (email: string) => Promise<void>;
}) {
  const { data: ticketTypes = [] } = useTickets(eventId);
  const types = useMemo(
    () => (ticketTypes as DeskTicketType[]).filter((t) => !t.isFaculty && t.isActive !== false),
    [ticketTypes],
  );

  const [fields, setFields] = useState<WalkInFields>(EMPTY_FIELDS);
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [pricingTierId, setPricingTierId] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentChoice>("complimentary");
  const [codeInput, setCodeInput] = useState("");
  const [promo, setPromo] = useState<PromoPreview | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  const [supportingDoc, setSupportingDoc] = useState<UploadedDocument | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Restore this desk's last type, rate and payment once the types load.
  useEffect(() => {
    if (ticketTypeId || types.length === 0) return;
    const saved = readRemembered(eventId);
    const type = types.find((t) => t.id === saved.ticketTypeId) ?? types[0];
    const tiers = (type.pricingTiers ?? []).filter((t) => t.isActive);
    setTicketTypeId(type.id);
    setPricingTierId(tiers.some((t) => t.id === saved.pricingTierId) ? saved.pricingTierId ?? null : defaultTierId(tiers));
    if (saved.payment) setPayment(saved.payment);
  }, [eventId, types, ticketTypeId]);

  const type = types.find((t) => t.id === ticketTypeId);
  const tiers = (type?.pricingTiers ?? []).filter((t) => t.isActive);
  const tier = tiers.find((t) => t.id === pricingTierId);
  const price = Number(tier?.price ?? type?.price ?? 0);
  const currency = tier?.currency ?? type?.currency ?? "USD";
  // A free rate takes no money, but a sponsor may still be the one paying.
  const effectivePayment: PaymentChoice = price === 0 && payment !== "inclusive" ? "complimentary" : payment;
  const takesCode = effectivePayment !== "complimentary";
  // Applied only for the inputs it was checked against: a late answer for an
  // earlier type, rate or code never counts (review of f694a318, MED).
  const codeIsApplied = !!promo && !!type && promo.key === promoKey(type.id, tier?.id, codeInput);
  const discount = codeIsApplied ? promo.discountAmount : 0;
  const choices: PaymentChoice[] = price === 0 ? ["complimentary", "inclusive"] : ["complimentary", "cash", "card", "inclusive"];
  const evidence = readIdentityEvidencePolicy(type);

  const set = (key: keyof WalkInFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));
  const pick = (key: keyof WalkInFields) => (value: string) => setFields((f) => ({ ...f, [key]: value }));

  // A checked code belongs to a type, a rate and a choice; any change re-checks it.
  const clearPromo = () => {
    setPromo(null);
    setPromoError(null);
  };

  const chooseType = (id: string) => {
    const next = types.find((t) => t.id === id);
    setTicketTypeId(id);
    setPricingTierId(defaultTierId((next?.pricingTiers ?? []).filter((t) => t.isActive)));
    setSupportingDoc(null);
    setDocumentError(null);
    clearPromo();
  };

  const choosePayment = (choice: PaymentChoice) => {
    setPayment(choice);
    clearPromo();
  };

  const checkCode = async () => {
    const code = codeInput.trim();
    if (!code || !type) return;
    setCheckingCode(true);
    setPromoError(null);
    try {
      const query = new URLSearchParams({ code, ticketTypeId: type.id });
      if (tier) query.set("pricingTierId", tier.id);
      if (effectivePayment === "inclusive") query.set("sponsor", "1");
      if (fields.email.trim()) query.set("email", fields.email.trim());
      const res = await fetch(`/api/events/${eventId}/registrations/walk-in/promo?${query}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.valid) {
        setPromo(null);
        setPromoError(data.error || "The code could not be checked");
        return;
      }
      setPromo({ ...(data as Omit<PromoPreview, "key">), key: promoKey(type.id, tier?.id, code) });
      // A sponsor's code on cash or card: the sponsor pays, so it is Inclusive.
      if (data.sponsorName && effectivePayment !== "inclusive") setPayment("inclusive");
    } catch (err) {
      console.error("[desk] code check failed", err);
      setPromoError("Network error: the code was not checked");
    } finally {
      setCheckingCode(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!type) {
      toast.error("Choose a registration type");
      return;
    }
    const missing = missingFields(fields, type);
    // Without a rate a tiered type reads as free, so a paid walk-in would be registered for nothing.
    if (tiers.length > 0 && !tier) missing.unshift("Rate");
    if (type.requiresDocument && type.documentRequired && !supportingDoc) missing.push(type.documentLabel || "Supporting document");
    if (missing.length > 0) {
      toast.error(`Still needed: ${missing.join(", ")}`);
      return;
    }
    if (takesCode && codeInput.trim() && !codeIsApplied) {
      toast.error("Apply the code first, to see what to collect");
      return;
    }
    if (effectivePayment === "inclusive" && !codeIsApplied) {
      toast.error("Enter and apply the sponsor's code");
      return;
    }
    const sent = submittedPayment(effectivePayment, codeIsApplied ? promo : null);
    const expectedPrice = codeIsApplied ? promo.finalPrice : price;
    if (sent === "card" && !/^\d{4}$/.test(fields.cardLast4)) {
      toast.error("Enter the last 4 digits of the card");
      return;
    }
    const { cardLast4, ...details } = fields;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/walk-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...details,
          ticketTypeId: type.id,
          pricingTierId: tier?.id,
          supportingDocumentUrl: supportingDoc?.url,
          supportingDocumentFilename: supportingDoc?.filename,
          payment: sent,
          promoCode: takesCode && codeIsApplied ? promo.code : undefined,
          // The price shown, after the code and before tax: the server refuses if its own differs.
          expectedPrice: takesCode ? expectedPrice : undefined,
          cardLast4: sent === "card" ? cardLast4 : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code === "PRICE_CHANGED") {
        clearPromo();
        toast.error("The price changed since it was shown. Apply the code again and check the amount.");
        return;
      }
      if (data.code === "ALREADY_REGISTERED") {
        toast.warning("Already registered. Find them in the search above.");
        onRegistered(fields.email.trim());
        return;
      }
      if (!res.ok) {
        toast.error(data.error || "The walk-in was not registered");
        return;
      }
      remember(eventId, { ticketTypeId: type.id, pricingTierId: tier?.id ?? null, payment });
      const email = fields.email.trim();
      setFields(EMPTY_FIELDS);
      setSupportingDoc(null);
      setCodeInput("");
      clearPromo();
      if (!data.checkedIn) {
        toast.warning(`${data.name} is registered but not checked in: ${data.error}`, { duration: 10000 });
        onRegistered(email);
        return;
      }
      toast.success(`${data.name} registered and checked in${data.paymentStatus === "INCLUSIVE" ? " (sponsor-paid)" : ""}`);
      await onDone(email);
    } catch (err) {
      console.error("[desk] walk-in failed", err);
      toast.error("Network error. Search for them before trying again, in case it went through.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={submit} className="space-y-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <UserPlus className="h-4 w-4 text-primary" /> New walk-in
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Registration type" required>
              {/* Radix Select reports "" when its options change; never let that clear a choice. */}
              <Select value={ticketTypeId} onValueChange={(v) => v && chooseType(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose a type" /></SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {tiers.length > 0 && (
              <Field label="Rate">
                <Select
                  value={pricingTierId ?? ""}
                  onValueChange={(v) => {
                    if (!v) return;
                    setPricingTierId(v);
                    clearPromo();
                  }}
                >
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose a rate" /></SelectTrigger>
                  <SelectContent>
                    {tiers.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name} · {money(t.price, t.currency)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>

          <div className="grid grid-cols-[110px_1fr_1fr] gap-3">
            <Field label="Title" required>
              <TitleSelect value={fields.title} onChange={pick("title")} />
            </Field>
            <Field label="First name" required htmlFor="walkin-first">
              <Input id="walkin-first" value={fields.firstName} onChange={set("firstName")} required />
            </Field>
            <Field label="Last name" required htmlFor="walkin-last">
              <Input id="walkin-last" value={fields.lastName} onChange={set("lastName")} required />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Email" required htmlFor="walkin-email">
              <Input id="walkin-email" type="email" value={fields.email} onChange={set("email")} required />
            </Field>
            <Field label="Additional email" htmlFor="walkin-email2">
              <Input id="walkin-email2" type="email" value={fields.additionalEmail} onChange={set("additionalEmail")} />
            </Field>
            <Field label="Position" required htmlFor="walkin-position">
              <Input id="walkin-position" value={fields.jobTitle} onChange={set("jobTitle")} required />
            </Field>
            <Field label="Organization" required htmlFor="walkin-org">
              <Input id="walkin-org" value={fields.organization} onChange={set("organization")} required />
            </Field>
            <Field label="Mobile number" required htmlFor="walkin-phone">
              <Input id="walkin-phone" type="tel" value={fields.phone} onChange={set("phone")} required />
            </Field>
            <Field label="Country" required>
              <CountrySelect value={fields.country} onChange={pick("country")} />
            </Field>
            <Field label="City" required htmlFor="walkin-city">
              <Input id="walkin-city" value={fields.city} onChange={set("city")} required />
            </Field>
            <Field label="Specialty" required>
              <SpecialtySelect value={fields.specialty} onChange={pick("specialty")} />
            </Field>
            <Field label="Role" required>
              <RoleSelect value={fields.role} onChange={pick("role")} />
            </Field>
            {fields.specialty === "Others" && (
              <Field label="Please specify the specialty" required htmlFor="walkin-custom-specialty" className="sm:col-span-2">
                <Input id="walkin-custom-specialty" value={fields.customSpecialty} onChange={set("customSpecialty")} required />
              </Field>
            )}
          </div>

          {asksForIdentityEvidence(evidence) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-amber-200 bg-amber-50/50 p-3">
              {evidence.requiresMemberId && (
                <>
                  <Field label="Association / Society" htmlFor="walkin-assoc">
                    <Input id="walkin-assoc" value={fields.associationName} onChange={set("associationName")} />
                  </Field>
                  <Field label="Member ID" required htmlFor="walkin-member">
                    <Input id="walkin-member" value={fields.memberId} onChange={set("memberId")} required />
                  </Field>
                </>
              )}
              {evidence.requiresStudentId && (
                <Field label="Student ID" required htmlFor="walkin-student">
                  <Input id="walkin-student" value={fields.studentId} onChange={set("studentId")} required />
                </Field>
              )}
              {evidence.requiresStudentIdExpiry && (
                <Field label="Student ID expiry" required htmlFor="walkin-student-expiry">
                  <Input id="walkin-student-expiry" type="date" value={fields.studentIdExpiry} onChange={set("studentIdExpiry")} required />
                </Field>
              )}
            </div>
          )}

          {type?.requiresDocument && (
            <SupportingDocumentField
              slug={eventSlug}
              uploadUrl={`/api/events/${eventId}/registrations/walk-in/document`}
              label={type.documentLabel || "Supporting document"}
              required={type.documentRequired === true}
              instructions={type.documentInstructions ?? null}
              value={supportingDoc}
              onChange={setSupportingDoc}
              error={documentError}
              onError={setDocumentError}
            />
          )}

          <div className="space-y-2">
            <Label>
              Payment
              {price > 0 && effectivePayment !== "inclusive" && (
                <span className="font-normal text-muted-foreground">
                  {" "}· collect {collectLabel({ amount: walkInTotal(price, currency, tax, discount), currency }, tax)}
                </span>
              )}
            </Label>
            {price === 0 && <p className="text-sm text-muted-foreground">Free rate: complimentary, or Inclusive when a sponsor brings them.</p>}
            <div className="flex flex-wrap items-center gap-2">
              {choices.map((choice) => (
                <Button
                  key={choice}
                  type="button"
                  size="sm"
                  variant={effectivePayment === choice ? "default" : "outline"}
                  onClick={() => choosePayment(choice)}
                >
                  {PAYMENT_LABEL[choice]}
                </Button>
              ))}
              {effectivePayment === "card" && !(codeIsApplied && promo.finalPrice === 0) && (
                <Input
                  aria-label="Card last 4 digits"
                  placeholder="Last 4"
                  value={fields.cardLast4}
                  onChange={(e) => setFields((f) => ({ ...f, cardLast4: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                  inputMode="numeric"
                  className="w-24 h-9"
                />
              )}
            </div>
            {takesCode && (
              <PromoCodeField
                sponsor={effectivePayment === "inclusive"}
                value={codeInput}
                onChange={(v) => {
                  setCodeInput(v);
                  setPromoError(null);
                }}
                onApply={checkCode}
                checking={checkingCode}
                applied={codeIsApplied ? promo : null}
                error={promoError}
                currency={currency}
              />
            )}
          </div>

          <Button type="submit" className="w-full h-12 btn-gradient text-base gap-2" disabled={submitting || !type}>
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <UserPlus className="h-5 w-5" />}
            Register & check in
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** The code a walk-in brings: checked before any money is taken. */
function PromoCodeField({
  sponsor,
  value,
  onChange,
  onApply,
  checking,
  applied,
  error,
  currency,
}: {
  sponsor: boolean;
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
  checking: boolean;
  applied: PromoPreview | null;
  error: string | null;
  currency: string;
}) {
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
      <Label htmlFor="walkin-code">
        {sponsor ? "Sponsor code" : "Promo code"}
        {sponsor ? <span className="text-red-500"> *</span> : <span className="font-normal text-muted-foreground"> (optional)</span>}
      </Label>
      <div className="flex gap-2">
        <Input
          id="walkin-code"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            onApply();
          }}
          placeholder={sponsor ? "The code the sponsor gave them" : "Discount code"}
          className="h-9 font-mono uppercase"
          autoComplete="off"
        />
        <Button type="button" size="sm" variant="outline" className="h-9" onClick={onApply} disabled={checking || !value.trim()}>
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Apply"}
        </Button>
      </div>
      {applied && <PromoResult promo={applied} currency={currency} />}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

function PromoResult({ promo, currency }: { promo: PromoPreview; currency: string }) {
  if (promo.sponsorName) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-green-800">
        <CheckCircle2 className="h-4 w-4" /> {promo.code}: paid by {promo.sponsorName}. Nothing to collect.
      </p>
    );
  }
  const free = promo.finalPrice === 0;
  return (
    <p className="flex items-center gap-1.5 text-sm text-green-800">
      <CheckCircle2 className="h-4 w-4" /> {promo.code}: {discountLabel(promo, currency)}
      {free && ". Nothing to collect; registered as complimentary."}
    </p>
  );
}
