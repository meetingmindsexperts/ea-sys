"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Banknote, Loader2, Printer, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTickets, queryKeys } from "@/hooks/use-api";
import { formatPersonName } from "@/lib/utils";
import { matchesRegistrationSearch } from "@/lib/registration-search";
import { asksForIdentityEvidence, missingIdentityEvidence, readIdentityEvidencePolicy } from "@/lib/identity-evidence";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { CountrySelect } from "@/components/ui/country-select";
import { SupportingDocumentField, type UploadedDocument } from "@/components/public/registration-form-extras";

/**
 * The onsite desk (docs/ONSITE_DESK_PLAN.md §4): find someone and check them
 * in with their badge, or register a walk-in, take the money and print, in one
 * step. Badges print through the browser's print dialog (owner's choice).
 */

interface DeskRegistration {
  id: string;
  serialId: number | null;
  status: string;
  paymentStatus: string;
  userId: string | null;
  completedAt?: string | null;
  attendee: { title?: string | null; firstName: string; lastName: string; email: string; organization?: string | null };
  ticketType: { name: string; price?: number | string } | null;
  pricingTier?: { price: number | string } | null;
  originalPrice?: number | string | null;
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

type PaymentChoice = "complimentary" | "cash" | "card";

const PAYMENT_LABEL: Record<PaymentChoice, string> = { complimentary: "Complimentary", cash: "Cash", card: "Card" };
const MAX_RESULTS = 8;
const OUTSTANDING = new Set(["UNASSIGNED", "UNPAID", "PENDING", "FAILED"]);

/**
 * Print one badge: the PDF loads in a hidden frame and the browser's print
 * dialog opens over the page. Returns the refusal message, or null when the
 * dialog was opened.
 */
async function printBadge(eventId: string, registrationId: string): Promise<string | null> {
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
  const price = r.originalPrice ?? r.pricingTier?.price ?? r.ticketType?.price ?? 0;
  return Number(price) > 0;
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
  registrations,
}: {
  eventId: string;
  eventSlug: string;
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

  const results = useMemo(() => {
    if (query.trim().length < 2) return [];
    return registrations.filter((r) => matchesRegistrationSearch(r, query)).slice(0, MAX_RESULTS);
  }, [registrations, query]);

  // Not invalidateQueries: the list is served with stale-while-revalidate=30, so
  // for 30 s the browser answers a refetch with the old list and the person the
  // desk just admitted is missing. Bypass the HTTP cache and write the result in.
  const refresh = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/registrations`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      queryClient.setQueryData(queryKeys.registrations(eventId), await res.json());
    } catch (err) {
      console.error("[desk] list refresh failed", err);
      await queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
    }
  };

  const printFor = async (r: DeskRegistration) => {
    const refusal = await printBadge(eventId, r.id);
    if (refusal) toast.error(`Checked in, but the badge did not print: ${refusal}`, { duration: 10000 });
  };

  const checkInAndPrint = async (r: DeskRegistration) => {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${r.id}/check-in`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.code === "PAYMENT_REQUIRED") {
        setPayingId(r.id);
        toast.warning("Payment is due. Record it, then the badge prints.");
        return;
      }
      if (!res.ok && data.code !== "ALREADY_CHECKED_IN") {
        toast.error(data.error || "Check-in failed");
        return;
      }
      toast.success(`${formatPersonName(r.attendee.title, r.attendee.firstName, r.attendee.lastName)} checked in`);
      await printFor(r);
      refresh();
    } catch (err) {
      console.error("[desk] check-in failed", err);
      toast.error("Network error: NOT checked in. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const reprint = async (r: DeskRegistration) => {
    setBusyId(r.id);
    try {
      const refusal = await printBadge(eventId, r.id);
      if (refusal) toast.error(refusal);
    } catch (err) {
      console.error("[desk] reprint failed", err);
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
          payMethod === "card" ? { method: "card_onsite", cardLast4: payLast4 } : { method: "cash", cashReceivedBy: operatorName },
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
      setPayingId(null);
      setPayLast4("");
    } catch (err) {
      console.error("[desk] payment failed", err);
      toast.error("Network error: the payment was NOT recorded");
      return;
    } finally {
      setBusyId(null);
    }
    await checkInAndPrint(r);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, email, organisation or registration number"
              className="pl-10 h-12 text-base"
              autoComplete="off"
              autoFocus
            />
          </div>
          {query.trim().length >= 2 && results.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">Nobody matches. Register them as a walk-in below.</p>
          )}
          <div className="space-y-2">
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
                  <RowAction
                    r={r}
                    busy={busyId === r.id}
                    onCheckIn={() => checkInAndPrint(r)}
                    onRecordPayment={() => setPayingId(r.id)}
                    onReprint={() => reprint(r)}
                  />
                </div>
                {payingId === r.id && (
                  <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/50 p-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Paid by</Label>
                      <Select value={payMethod} onValueChange={(v) => setPayMethod(v as "cash" | "card")}>
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
                      Record payment, check in & print
                    </Button>
                    <Button size="sm" variant="ghost" className="h-9" onClick={() => setPayingId(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <WalkInForm
        eventId={eventId}
        eventSlug={eventSlug}
        onRegistered={(email) => {
          setQuery(email);
          refresh();
        }}
        onDone={async (registrationId, email) => {
          const refusal = await printBadge(eventId, registrationId);
          if (refusal) toast.error(`Checked in, but the badge did not print: ${refusal}`, { duration: 10000 });
          // Show the new row once the list has it, so the desk sees "Checked in".
          await refresh();
          setQuery(email);
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
  onReprint,
}: {
  r: DeskRegistration;
  busy: boolean;
  onCheckIn: () => void;
  onRecordPayment: () => void;
  onReprint: () => void;
}) {
  if (r.status === "CANCELLED") return null;
  if (busy) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground shrink-0" />;
  if (r.status === "CHECKED_IN") {
    return (
      <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={onReprint}>
        <Printer className="h-4 w-4" /> Reprint badge
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
      <Printer className="h-4 w-4" /> Check in & print
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
  onRegistered,
  onDone,
}: {
  eventId: string;
  /** For the supporting-document upload, which goes through the public form's route. */
  eventSlug: string;
  /** Registered, but a later step did not finish: show them in search. */
  onRegistered: (email: string) => void;
  onDone: (registrationId: string, email: string) => Promise<void>;
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
  const effectivePayment: PaymentChoice = price === 0 ? "complimentary" : payment;
  const evidence = readIdentityEvidencePolicy(type);

  const set = (key: keyof WalkInFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));
  const pick = (key: keyof WalkInFields) => (value: string) => setFields((f) => ({ ...f, [key]: value }));

  const chooseType = (id: string) => {
    const next = types.find((t) => t.id === id);
    setTicketTypeId(id);
    setPricingTierId(defaultTierId((next?.pricingTiers ?? []).filter((t) => t.isActive)));
    setSupportingDoc(null);
    setDocumentError(null);
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
    if (effectivePayment === "card" && !/^\d{4}$/.test(fields.cardLast4)) {
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
          payment: effectivePayment,
          cardLast4: effectivePayment === "card" ? cardLast4 : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
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
      if (!data.checkedIn) {
        toast.warning(`${data.name} is registered but not checked in: ${data.error}`, { duration: 10000 });
        onRegistered(email);
        return;
      }
      toast.success(`${data.name} registered and checked in`);
      await onDone(data.registrationId, email);
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
                <Select value={pricingTierId ?? ""} onValueChange={(v) => v && setPricingTierId(v)}>
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
              label={type.documentLabel || "Supporting document"}
              required={type.documentRequired === true}
              instructions={type.documentInstructions ?? null}
              value={supportingDoc}
              onChange={setSupportingDoc}
              error={documentError}
              onError={setDocumentError}
            />
          )}

          <div className="space-y-1">
            <Label>Payment {price > 0 && <span className="font-normal text-muted-foreground">· {money(price, currency)} before tax</span>}</Label>
            {price === 0 ? (
              <p className="text-sm text-muted-foreground">Free rate: registered as complimentary.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {(["complimentary", "cash", "card"] as const).map((choice) => (
                  <Button
                    key={choice}
                    type="button"
                    size="sm"
                    variant={payment === choice ? "default" : "outline"}
                    onClick={() => setPayment(choice)}
                  >
                    {PAYMENT_LABEL[choice]}
                  </Button>
                ))}
                {payment === "card" && (
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
            )}
          </div>

          <Button type="submit" className="w-full h-12 btn-gradient text-base gap-2" disabled={submitting || !type}>
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Printer className="h-5 w-5" />}
            Register, check in & print
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
