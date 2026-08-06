"use client";

/**
 * Public GROUP registration (docs/GROUP_REGISTRATION_PLAN.md, Phase 1).
 *
 * Link-only entry — the organizer copies this URL from Event Settings →
 * Registration → Group Registration and sends it to company reps. A
 * coordinator creates an account, enters the company payer, adds members
 * (each with the full public field-set + a registration type at the live
 * tier price), sees the cumulative total, and submits.
 *
 * Phase 2 (card): the consolidated invoice is issued either way — a
 * coordinator is often NOT the person holding the company card, so leaving
 * them without a document until someone pays would strand the common case.
 * The success card then offers immediate card settlement on top.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Calendar, MapPin, Users, Building2, Plus, Trash2, CheckCircle2, Loader2, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EventBanner } from "@/components/public/event-banner";
import { TitleSelect } from "@/components/ui/title-select";
import { CountrySelect } from "@/components/ui/country-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import {
  livePrice,
  purchasableTypes,
  type PublicTicketType,
} from "@/lib/public-ticket-price";

interface PublicEvent {
  id: string;
  name: string;
  slug: string;
  startDate: string;
  endDate: string | null;
  venue: string | null;
  city: string | null;
  bannerImage: string | null;
  bannerImageMobile: string | null;
  taxRate: number | string | null;
  taxLabel: string | null;
  registrationOpen: boolean;
  eventFull: boolean;
  ticketTypes: PublicTicketType[];
  groupRegistration: { enabled: boolean; minMembers: number; maxMembers: number };
}

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
  role: string;
  specialty: string;
  customSpecialty: string;
}

const EMPTY_MEMBER: MemberForm = {
  ticketTypeId: "",
  title: "",
  firstName: "",
  lastName: "",
  email: "",
  organization: "",
  jobTitle: "",
  phone: "",
  city: "",
  country: "",
  role: "",
  specialty: "",
  customSpecialty: "",
};

function GroupRegisterContent() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  // Coordinator
  const [coFirst, setCoFirst] = useState("");
  const [coLast, setCoLast] = useState("");
  const [coEmail, setCoEmail] = useState("");
  const [coPassword, setCoPassword] = useState("");
  const [attending, setAttending] = useState(true);
  // Payer
  const [payer, setPayer] = useState({
    name: "", contactName: "", email: "", phone: "", address: "", city: "", country: "", taxNumber: "",
  });
  const [payerReference, setPayerReference] = useState("");
  // Members
  const [members, setMembers] = useState<MemberForm[]>([{ ...EMPTY_MEMBER }]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{
    groupId: string;
    memberCount: number;
    invoiceNumber: string | null;
    total: string;
    payable: boolean;
  } | null>(null);
  const [payingByCard, setPayingByCard] = useState(false);

  // Stripe return: `?group=<id>&payment=success|cancelled`. Read once — the
  // group is already created by this point, so this only chooses which card
  // to render, never re-submits anything.
  const searchParams = useSearchParams();
  const returnedGroupId = searchParams.get("group");
  const returnedPayment = searchParams.get("payment");

  /**
   * Settle the whole group by card. Never assumes the redirect will happen —
   * a failure here must leave the coordinator on a page that still tells them
   * the invoice is valid, because the registration itself already succeeded.
   */
  const payByCard = useCallback(async (groupId: string) => {
    setPayingByCard(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/group-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      const data = await res.json();
      if (!res.ok || !data.checkoutUrl) {
        console.error("group-checkout: failed", data);
        toast.error(
          data.error || "We couldn't start the card payment. You can still pay by bank transfer using the invoice.",
        );
        return;
      }
      window.location.href = data.checkoutUrl;
    } catch (err) {
      console.error("group-checkout: error", err);
      toast.error("We couldn't reach the payment page. Your invoice is still valid — please try again or pay by transfer.");
    } finally {
      setPayingByCard(false);
    }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/events/${slug}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PublicEvent;
        if (!cancelled) {
          setEvent(data);
          setLoadState("ready");
        }
      } catch (err) {
        console.error("group-register: event load failed", err);
        if (!cancelled) setLoadState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const buyableTypes = useMemo(
    () => purchasableTypes(event?.ticketTypes ?? []),
    [event],
  );
  const currency = buyableTypes[0]?.currency ?? "USD";

  const totals = useMemo(() => {
    const subtotal = members.reduce((sum, m) => {
      const t = buyableTypes.find((x) => x.id === m.ticketTypeId);
      return t ? sum + livePrice(t).price : sum;
    }, 0);
    const rate = event?.taxRate ? Number(event.taxRate) : 0;
    const tax = rate > 0 ? subtotal * (rate / 100) : 0;
    return { subtotal, tax, total: subtotal + tax, rate };
  }, [members, buyableTypes, event]);

  const settings = event?.groupRegistration;
  const maxMembers = settings?.maxMembers ?? 10;
  const minMembers = settings?.minMembers ?? 2;

  const updateMember = useCallback((idx: number, patch: Partial<MemberForm>) => {
    setMembers((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }, []);

  // When the coordinator attends, member #1 mirrors their identity.
  useEffect(() => {
    if (!attending) return;
    setMembers((prev) => {
      const first = prev[0] ?? { ...EMPTY_MEMBER };
      return [{ ...first, firstName: coFirst, lastName: coLast, email: coEmail }, ...prev.slice(1)];
    });
  }, [attending, coFirst, coLast, coEmail]);

  const addMember = () => {
    if (members.length >= maxMembers) return;
    setMembers((prev) => [...prev, { ...EMPTY_MEMBER }]);
  };
  const removeMember = (idx: number) => {
    if (attending && idx === 0) return;
    setMembers((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!event) return;
    // Client-side sanity (server re-validates everything).
    if (!coFirst.trim() || !coLast.trim() || !coEmail.trim() || coPassword.length < 8) {
      toast.error("Fill in your coordinator details (password at least 8 characters).");
      return;
    }
    if (!payer.name.trim()) {
      toast.error("Enter the paying company / institution name.");
      return;
    }
    if (members.length < minMembers) {
      toast.error(`A group needs at least ${minMembers} members.`);
      return;
    }
    for (const [i, m] of members.entries()) {
      const missing = [
        !m.ticketTypeId && "registration type",
        !m.firstName.trim() && "first name",
        !m.lastName.trim() && "last name",
        !m.email.trim() && "email",
        !m.organization.trim() && "organization",
        !m.jobTitle.trim() && "job title",
        !m.phone.trim() && "phone",
        !m.city.trim() && "city",
        !m.country.trim() && "country",
        !m.role && "role",
        !m.specialty && "specialty",
        m.specialty === "Others" && !m.customSpecialty.trim() && "custom specialty",
      ].filter(Boolean);
      if (missing.length > 0) {
        toast.error(`Member ${i + 1}: missing ${missing.join(", ")}.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/group-register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinator: {
            firstName: coFirst.trim(),
            lastName: coLast.trim(),
            email: coEmail.trim(),
            password: coPassword,
            attending,
          },
          payer: {
            name: payer.name.trim(),
            contactName: payer.contactName.trim() || undefined,
            email: payer.email.trim() || undefined,
            phone: payer.phone.trim() || undefined,
            address: payer.address.trim() || undefined,
            city: payer.city.trim() || undefined,
            country: payer.country.trim() || undefined,
            taxNumber: payer.taxNumber.trim() || undefined,
          },
          payerReference: payerReference.trim() || undefined,
          members: members.map((m) => ({
            ticketTypeId: m.ticketTypeId,
            attendee: {
              title: m.title || undefined,
              firstName: m.firstName.trim(),
              lastName: m.lastName.trim(),
              email: m.email.trim(),
              organization: m.organization.trim(),
              jobTitle: m.jobTitle.trim(),
              phone: m.phone.trim(),
              city: m.city.trim(),
              country: m.country,
              role: m.role,
              specialty: m.specialty,
              customSpecialty: m.customSpecialty.trim() || undefined,
            },
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("group-register: submit failed", data);
        toast.error(data.error || "Group registration failed. Please try again.");
        return;
      }
      // L7: the success card shows the SERVER's totals (authoritative), not
      // the client-side estimate — the two can differ if a tier flipped
      // between page load and submit.
      const serverSubtotal = Number(data.subtotal ?? 0);
      const rate = event?.taxRate ? Number(event.taxRate) : 0;
      const serverTotal = serverSubtotal + (rate > 0 ? serverSubtotal * (rate / 100) : 0);
      setDone({
        groupId: data.groupId,
        memberCount: data.memberCount,
        invoiceNumber: data.invoiceNumber ?? null,
        total: `${data.currency} ${serverTotal.toFixed(2)}`,
        payable: serverTotal > 0,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error("group-register: submit error", err);
      // L2: after a timeout the POST may have committed server-side — never
      // assert "NOT registered"; steer to email-first before retrying.
      toast.error("We couldn't confirm your group registration. Check your email before retrying — it may have gone through.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadState === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (loadState === "error" || !event) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold mb-2">Event not found</h1>
          <p className="text-muted-foreground">This event doesn&apos;t exist or is not open.</p>
        </div>
      </div>
    );
  }

  const closed = !event.groupRegistration.enabled || !event.registrationOpen || event.eventFull;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <EventBanner banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} className="block w-full h-auto rounded-xl mb-6" priority />
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">{event.name}</h1>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {new Date(event.startDate).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            </span>
            {(event.venue || event.city) && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-4 w-4" />
                {[event.venue, event.city].filter(Boolean).join(", ")}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 font-medium text-cyan-700">
              <Users className="h-4 w-4" /> Group Registration
            </span>
          </div>
        </div>

        {returnedPayment === "success" ? (
          <div className="rounded-xl border bg-white p-8 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500 mb-4" />
            <h2 className="text-2xl font-semibold mb-2">Payment received</h2>
            <p className="text-slate-600">
              Thank you — your group registration is paid in full. A paid invoice is on its way to
              the company and to you.
            </p>
            <p className="text-sm text-slate-500 mt-3">
              Every member keeps the confirmation email they already received.
            </p>
          </div>
        ) : returnedPayment === "cancelled" ? (
          <div className="rounded-xl border bg-white p-8 text-center">
            <h2 className="text-2xl font-semibold mb-2">Payment cancelled</h2>
            <p className="text-slate-600">
              No payment was taken and <strong>your group registration is safe</strong> — everyone
              is still registered. You can pay by card now, or by bank transfer using the
              consolidated invoice that was emailed to you.
            </p>
            {returnedGroupId ? (
              <Button
                className="mt-5"
                onClick={() => payByCard(returnedGroupId)}
                disabled={payingByCard}
              >
                {payingByCard ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening payment…</>
                ) : (
                  <><CreditCard className="mr-2 h-4 w-4" /> Try card payment again</>
                )}
              </Button>
            ) : null}
          </div>
        ) : done ? (
          <div className="rounded-xl border bg-white p-8 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500 mb-4" />
            <h2 className="text-2xl font-semibold mb-2">Group registered!</h2>
            <p className="text-slate-600 mb-1">
              {done.memberCount} member{done.memberCount === 1 ? "" : "s"} registered — total <strong>{done.total}</strong>.
            </p>
            <p className="text-slate-600">
              {done.invoiceNumber
                ? <>Consolidated invoice <strong>{done.invoiceNumber}</strong> has been emailed to the company and to you.</>
                : "The consolidated invoice will be emailed shortly."}
            </p>
            <p className="text-sm text-slate-500 mt-3">
              Each member has received their own confirmation email. Registration is confirmed on receipt of payment.
            </p>
            <p className="text-sm mt-3">
              <a href={`/e/${slug}/my-group`} className="text-cyan-700 underline underline-offset-2">
                View your group
              </a>{" "}
              <span className="text-slate-500">— everyone&apos;s status, the invoice, and payment.</span>
            </p>
            {done.payable ? (
              <div className="mt-6 border-t pt-6">
                <p className="text-sm text-slate-600 mb-3">
                  Paying by card? Settle the whole group now — or ignore this and pay the invoice by
                  bank transfer.
                </p>
                <Button onClick={() => payByCard(done.groupId)} disabled={payingByCard}>
                  {payingByCard ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening payment…</>
                  ) : (
                    <><CreditCard className="mr-2 h-4 w-4" /> Pay {done.total} by card</>
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        ) : closed ? (
          <div className="rounded-xl border bg-white p-8 text-center">
            <h2 className="text-xl font-semibold mb-2">Group registration is not open</h2>
            <p className="text-slate-600">
              {event.eventFull
                ? "This event has reached its maximum number of attendees."
                : "Group registration is not currently available for this event. Please contact the organizing team."}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Coordinator */}
            <section className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold mb-1">1. Your details (group coordinator)</h2>
              <p className="text-sm text-slate-500 mb-4">
                You manage this group. An account is created (or your existing account is used) so you can view and update the group later.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><Label>First name *</Label><Input value={coFirst} onChange={(e) => setCoFirst(e.target.value)} /></div>
                <div><Label>Last name *</Label><Input value={coLast} onChange={(e) => setCoLast(e.target.value)} /></div>
                <div><Label>Email *</Label><Input type="email" value={coEmail} onChange={(e) => setCoEmail(e.target.value)} /></div>
                <div><Label>Password *</Label><Input type="password" value={coPassword} onChange={(e) => setCoPassword(e.target.value)} placeholder="Min 8 characters" /></div>
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <Checkbox checked={attending} onCheckedChange={(v) => setAttending(v === true)} />
                I am attending the event myself (my details become member #1)
              </label>
            </section>

            {/* Payer */}
            <section className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold mb-1 inline-flex items-center gap-2">
                <Building2 className="h-5 w-5 text-slate-400" /> 2. Who pays (company / institution)
              </h2>
              <p className="text-sm text-slate-500 mb-4">
                The consolidated invoice is issued to this payer. Members are never asked to pay individually.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2"><Label>Company / institution name *</Label><Input value={payer.name} onChange={(e) => setPayer({ ...payer, name: e.target.value })} /></div>
                <div><Label>Contact person</Label><Input value={payer.contactName} onChange={(e) => setPayer({ ...payer, contactName: e.target.value })} /></div>
                <div><Label>Billing email</Label><Input type="email" value={payer.email} onChange={(e) => setPayer({ ...payer, email: e.target.value })} /></div>
                <div><Label>Phone</Label><Input value={payer.phone} onChange={(e) => setPayer({ ...payer, phone: e.target.value })} /></div>
                <div><Label>Tax / VAT number</Label><Input value={payer.taxNumber} onChange={(e) => setPayer({ ...payer, taxNumber: e.target.value })} /></div>
                <div className="sm:col-span-2"><Label>Address</Label><Input value={payer.address} onChange={(e) => setPayer({ ...payer, address: e.target.value })} /></div>
                <div><Label>City</Label><Input value={payer.city} onChange={(e) => setPayer({ ...payer, city: e.target.value })} /></div>
                <div><Label>Country</Label><CountrySelect value={payer.country} onChange={(v) => setPayer({ ...payer, country: v })} /></div>
                <div className="sm:col-span-2"><Label>PO / reference (optional)</Label><Input value={payerReference} onChange={(e) => setPayerReference(e.target.value)} placeholder="Printed on the invoice" /></div>
              </div>
            </section>

            {/* Members */}
            <section className="rounded-xl border bg-white p-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-lg font-semibold">3. Group members</h2>
                <span className="text-sm text-slate-500">{members.length} of max {maxMembers} (min {minMembers})</span>
              </div>
              <p className="text-sm text-slate-500 mb-4">Enter each attendee&apos;s details and pick their registration type.</p>

              <div className="space-y-6">
                {members.map((m, idx) => {
                  const isCoordinatorRow = attending && idx === 0;
                  const type = buyableTypes.find((t) => t.id === m.ticketTypeId);
                  const priceInfo = type ? livePrice(type) : null;
                  return (
                    <div key={idx} className="rounded-lg border border-slate-200 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-medium text-sm">
                          Member {idx + 1}{isCoordinatorRow ? " — you" : ""}
                        </span>
                        {!isCoordinatorRow && members.length > 1 && (
                          <Button variant="ghost" size="sm" onClick={() => removeMember(idx)}>
                            <Trash2 className="h-4 w-4 text-slate-400" />
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div>
                          <Label>Registration type *</Label>
                          <Select value={m.ticketTypeId} onValueChange={(v) => updateMember(idx, { ticketTypeId: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="Select type" /></SelectTrigger>
                            <SelectContent>
                              {buyableTypes.map((t) => {
                                const p = livePrice(t);
                                return (
                                  <SelectItem key={t.id} value={t.id}>
                                    {t.name}{p.tierName ? ` (${p.tierName})` : ""} — {t.currency ?? "USD"} {p.price.toFixed(2)}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                          {priceInfo && (
                            <p className="text-xs text-slate-500 mt-1">{currency} {priceInfo.price.toFixed(2)}{priceInfo.tierName ? ` · ${priceInfo.tierName}` : ""}</p>
                          )}
                        </div>
                        <div><Label>Title</Label><TitleSelect value={m.title} onChange={(v) => updateMember(idx, { title: v })} /></div>
                        <div className="hidden lg:block" />
                        <div><Label>First name *</Label><Input value={m.firstName} onChange={(e) => updateMember(idx, { firstName: e.target.value })} disabled={isCoordinatorRow} /></div>
                        <div><Label>Last name *</Label><Input value={m.lastName} onChange={(e) => updateMember(idx, { lastName: e.target.value })} disabled={isCoordinatorRow} /></div>
                        <div><Label>Email *</Label><Input type="email" value={m.email} onChange={(e) => updateMember(idx, { email: e.target.value })} disabled={isCoordinatorRow} /></div>
                        <div><Label>Organization *</Label><Input value={m.organization} onChange={(e) => updateMember(idx, { organization: e.target.value })} /></div>
                        <div><Label>Job title *</Label><Input value={m.jobTitle} onChange={(e) => updateMember(idx, { jobTitle: e.target.value })} /></div>
                        <div><Label>Phone *</Label><Input value={m.phone} onChange={(e) => updateMember(idx, { phone: e.target.value })} /></div>
                        <div><Label>City *</Label><Input value={m.city} onChange={(e) => updateMember(idx, { city: e.target.value })} /></div>
                        <div><Label>Country *</Label><CountrySelect value={m.country} onChange={(v) => updateMember(idx, { country: v })} /></div>
                        <div><Label>Role *</Label><RoleSelect value={m.role} onChange={(v) => updateMember(idx, { role: v })} /></div>
                        <div><Label>Specialty *</Label><SpecialtySelect value={m.specialty} onChange={(v) => updateMember(idx, { specialty: v })} /></div>
                        {m.specialty === "Others" && (
                          <div><Label>Custom specialty *</Label><Input value={m.customSpecialty} onChange={(e) => updateMember(idx, { customSpecialty: e.target.value })} /></div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {members.length < maxMembers && (
                <Button variant="outline" className="mt-4" onClick={addMember}>
                  <Plus className="h-4 w-4 mr-1" /> Add member
                </Button>
              )}
            </section>

            {/* Total + submit */}
            <section className="rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold mb-4">4. Review &amp; submit</h2>
              <div className="space-y-1 text-sm max-w-sm">
                <div className="flex justify-between"><span className="text-slate-500">Subtotal ({members.length} member{members.length === 1 ? "" : "s"})</span><span>{currency} {totals.subtotal.toFixed(2)}</span></div>
                {totals.rate > 0 && (
                  <div className="flex justify-between"><span className="text-slate-500">{event.taxLabel || "VAT"} ({totals.rate}%)</span><span>{currency} {totals.tax.toFixed(2)}</span></div>
                )}
                <div className="flex justify-between font-semibold text-base pt-1 border-t"><span>Total</span><span>{currency} {totals.total.toFixed(2)}</span></div>
              </div>
              <p className="text-sm text-slate-500 mt-4">
                Submitting registers all members and emails the consolidated invoice to the payer. Payment is by bank transfer (details on the invoice); registration is confirmed on receipt of payment.
              </p>
              <Button className="mt-4" size="lg" onClick={handleSubmit} disabled={submitting}>
                {submitting ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Registering group…</>) : `Register group (${members.length})`}
              </Button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * `useSearchParams` (the Stripe return) requires a Suspense boundary during
 * prerender — same wrapper the confirmation page uses.
 */
export default function GroupRegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <GroupRegisterContent />
    </Suspense>
  );
}
