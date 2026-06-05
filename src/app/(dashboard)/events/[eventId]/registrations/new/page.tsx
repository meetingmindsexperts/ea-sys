"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PersonFormFields, type PersonFormData } from "@/components/forms/person-form-fields";
import { ArrowLeft, UserPlus, Save, Ticket } from "lucide-react";
import { useTickets, useBillingAccounts, useEventTags } from "@/hooks/use-api";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import type { TicketType } from "../types";
import {
  MANUAL_PAYMENT_STATUS_HELPER_TEXT,
  MANUAL_PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  PaymentStatus,
} from "../registration-enums";

const initialPersonData: PersonFormData = {
  email: "",
  firstName: "",
  lastName: "",
  organization: "",
  jobTitle: "",
  phone: "",
  photo: null,
  city: "",
  country: "",
  specialty: "",
  tags: [],
  dietaryReqs: "",
};

export default function NewRegistrationPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const { data: ticketTypes = [] } = useTickets(eventId);
  // Per-event scoped: only payers attached to THIS event via the
  // EventBillingAccount junction appear here. Manage attachments from
  // Settings → Billing → Used in N events.
  const { data: billingAccounts = [] } = useBillingAccounts({ eventId });
  // Feed the tag autocomplete dropdown — same source as the bulk-tag
  // dialog and the filter, so the operator sees a consistent set of
  // existing tags across all entry points.
  const tagsQuery = useEventTags(eventId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    ticketTypeId: string;
    pricingTierId: string;
    paymentStatus: PaymentStatus;
    billingAccountId: string;
    payerReference: string;
    attendeeIsGuarantor: boolean;
    personData: PersonFormData;
    notes: string;
  }>({
    ticketTypeId: "",
    pricingTierId: "",
    paymentStatus: PaymentStatus.UNASSIGNED,
    billingAccountId: "",
    payerReference: "",
    attendeeIsGuarantor: false,
    personData: initialPersonData,
    notes: "",
  });

  // When the admin picks a ticket type, expose ALL its pricing tiers —
  // active AND inactive. Admin manual-add gets full control over which
  // tier to assign (e.g. record a late registrant at the closed Early
  // Bird rate as a courtesy). The public self-register path stays
  // active-only; the backend service validates tier→ticket-type
  // membership but does NOT require isActive, so inactive tiers are
  // accepted here by design. Tiers come pre-included on the
  // /api/events/[id]/tickets response; no extra fetch needed.
  const availableTiers = (() => {
    if (!formData.ticketTypeId) return [];
    const tt = (ticketTypes as TicketType[]).find((t) => t.id === formData.ticketTypeId);
    return tt?.pricingTiers ?? [];
  })();

  /**
   * Auto-default the payment status when the ticket/tier selection resolves
   * to a free registration: free → COMPLIMENTARY (no Stripe charge ever
   * happens), and revert COMPLIMENTARY → UNASSIGNED when switching back to a
   * paid selection. Explicit admin choices (PAID / UNPAID / INCLUSIVE) are
   * preserved — we only ever flip into/out of the COMPLIMENTARY auto-default.
   */
  const paymentStatusForSelection = (
    ticketTypeId: string,
    pricingTierId: string,
    current: PaymentStatus,
  ): PaymentStatus => {
    const tt = (ticketTypes as TicketType[]).find((t) => t.id === ticketTypeId);
    const tiers = tt?.pricingTiers ?? [];
    let isFree: boolean;
    if (!ticketTypeId || !tt) {
      isFree = true; // no type = no charge
    } else if (pricingTierId) {
      const tier = tiers.find((t) => t.id === pricingTierId);
      isFree = tier ? Number(tier.price) === 0 : Number(tt.price) === 0;
    } else if (tiers.length > 0) {
      isFree = false; // tiered type with no tier picked yet — price undetermined
    } else {
      isFree = Number(tt.price) === 0;
    }
    if (isFree) return PaymentStatus.COMPLIMENTARY;
    if (current === PaymentStatus.COMPLIMENTARY) return PaymentStatus.UNASSIGNED;
    return current;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/events/${eventId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketTypeId: formData.ticketTypeId || undefined,
          // Only send pricingTierId when it matches the picked ticket type —
          // a stale selection (admin changed ticket type after picking a
          // tier) would otherwise fail server-side validation.
          pricingTierId:
            formData.pricingTierId && availableTiers.some((t) => t.id === formData.pricingTierId)
              ? formData.pricingTierId
              : undefined,
          paymentStatus: formData.paymentStatus,
          // "Charge to another account" — orthogonal to paymentStatus.
          billingAccountId: formData.billingAccountId || undefined,
          payerReference:
            formData.billingAccountId && formData.payerReference
              ? formData.payerReference
              : undefined,
          attendeeIsGuarantor: formData.billingAccountId
            ? formData.attendeeIsGuarantor
            : undefined,
          attendee: {
            email: formData.personData.email,
            firstName: formData.personData.firstName,
            lastName: formData.personData.lastName,
            organization: formData.personData.organization || undefined,
            jobTitle: formData.personData.jobTitle || undefined,
            phone: formData.personData.phone || undefined,
            photo: formData.personData.photo || undefined,
            city: formData.personData.city || undefined,
            country: formData.personData.country || undefined,
            specialty: formData.personData.specialty || undefined,
            tags: formData.personData.tags && formData.personData.tags.length > 0 ? formData.personData.tags : undefined,
            dietaryReqs: formData.personData.dietaryReqs || undefined,
          },
          notes: formData.notes || undefined,
        }),
      });

      if (res.ok) {
        toast.success("Registration created successfully");
        router.push(`/events/${eventId}/registrations`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create registration");
      }
    } catch (err) {
      console.error("[registration-create] failed", err);
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link
          href={`/events/${eventId}/registrations`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Registrations
        </Link>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300 flex items-center justify-center shrink-0">
            <UserPlus className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add Registration</h1>
            <p className="text-sm text-muted-foreground">
              Manually register an attendee for this event
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section 1: Registration Type */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Ticket className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Registration Type</CardTitle>
            </div>
            <CardDescription>
              Select a registration type for this attendee
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ticketType">Type</Label>
                <Select
                  value={formData.ticketTypeId}
                  onValueChange={(value) => {
                    const ticketTypeId = value === "__none__" ? "" : value;
                    setFormData({
                      ...formData,
                      ticketTypeId,
                      // Reset tier when ticket type changes — old tier likely
                      // belongs to a different ticket type now.
                      pricingTierId: "",
                      paymentStatus: paymentStatusForSelection(
                        ticketTypeId,
                        "",
                        formData.paymentStatus,
                      ),
                    });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No registration type (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {(ticketTypes as TicketType[]).map((regType) => {
                      // Hide the "- $X" suffix when the type has ANY pricing
                      // tiers (active or inactive) — the Pricing Tier dropdown
                      // is the source of truth on the admin manual-add path,
                      // which can assign inactive tiers too. Also hide when the
                      // base price is 0 (avoids misleading "$0" on free/
                      // tier-priced types).
                      const hasTiers = (regType.pricingTiers ?? []).length > 0;
                      const showPrice = !hasTiers && regType.price > 0;
                      const unavailable = regType.soldCount >= regType.quantity;
                      return (
                        <SelectItem
                          key={regType.id}
                          value={regType.id}
                          disabled={unavailable}
                        >
                          {showPrice
                            ? `${regType.name} - $${regType.price}`
                            : regType.name}
                          {unavailable ? " (Unavailable)" : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Optional — leave empty to register without a type
                </p>
              </div>
              {/* Pricing tier — rendered when the picked ticket type has ANY
                  tiers (active OR inactive). Admin manual-add gets full control
                  over which tier to assign (e.g. record a late registrant at
                  the closed Early Bird rate as a courtesy). Optional so legacy
                  ticket types without tiers keep working. */}
              {availableTiers.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="pricingTier">Pricing Tier</Label>
                  <Select
                    value={formData.pricingTierId}
                    onValueChange={(value) => {
                      const pricingTierId = value === "__none__" ? "" : value;
                      setFormData({
                        ...formData,
                        pricingTierId,
                        paymentStatus: paymentStatusForSelection(
                          formData.ticketTypeId,
                          pricingTierId,
                          formData.paymentStatus,
                        ),
                      });
                    }}
                  >
                    <SelectTrigger id="pricingTier" className="w-full">
                      <SelectValue placeholder="Pick a tier (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {availableTiers.map((tier) => (
                        <SelectItem key={tier.id} value={tier.id}>
                          {tier.name}
                          {tier.isActive ? "" : " (inactive)"} — {tier.currency}{" "}
                          {tier.price}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Tracks which pricing window this registration falls under
                    (for finance reporting). Closed tiers are still selectable —
                    you have full control over which rate to apply.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="paymentStatus">Payment Status</Label>
                <Select
                  value={formData.paymentStatus}
                  onValueChange={(value) => setFormData({ ...formData, paymentStatus: value as PaymentStatus })}
                >
                  <SelectTrigger id="paymentStatus" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MANUAL_PAYMENT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {PAYMENT_STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {MANUAL_PAYMENT_STATUS_HELPER_TEXT}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section 1b: Billing — charge to another account */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Billing</CardTitle>
            <CardDescription>
              By default the attendee is billed. To charge a hospital,
              company, or grant instead, pick a payer — the invoice is
              addressed to them. This does not change the payment status;
              money is still owed until the payer settles.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="payer">Charge to</Label>
                <Select
                  value={formData.billingAccountId || "__self__"}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      billingAccountId: value === "__self__" ? "" : value,
                      payerReference: value === "__self__" ? "" : formData.payerReference,
                      attendeeIsGuarantor:
                        value === "__self__" ? false : formData.attendeeIsGuarantor,
                    })
                  }
                >
                  <SelectTrigger id="payer" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__self__">The attendee (self-pay)</SelectItem>
                    {billingAccounts.map((ba) => (
                      <SelectItem key={ba.id} value={ba.id}>
                        {ba.name} ({ba.type})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Manage payers in Settings → Billing → Billing Accounts.
                </p>
              </div>
              {formData.billingAccountId && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="payerRef">PO / Grant reference (optional)</Label>
                    <Input
                      id="payerRef"
                      value={formData.payerReference}
                      onChange={(e) =>
                        setFormData({ ...formData, payerReference: e.target.value })
                      }
                      placeholder="PO-12345 / grant code — printed on the invoice"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="guarantor"
                      checked={formData.attendeeIsGuarantor}
                      onCheckedChange={(c) =>
                        setFormData({ ...formData, attendeeIsGuarantor: c === true })
                      }
                    />
                    <Label htmlFor="guarantor" className="text-sm font-normal leading-snug">
                      Attendee is guarantor — if the payer doesn&apos;t settle,
                      the balance can be reverted to the attendee (keeps their
                      Pay-Now path available).
                    </Label>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Section 2: Attendee Details */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Attendee Details</CardTitle>
            <CardDescription>
              Personal and contact information for the attendee
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PersonFormFields
              data={formData.personData}
              onChange={(personData) => setFormData({ ...formData, personData })}
              showDietaryReqs={true}
              tagSuggestions={(tagsQuery.data?.tags ?? []).map((t) => t.tag)}
            />
          </CardContent>
        </Card>

        {/* Section 3: Additional Notes */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Additional Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Optional notes about this registration"
              />
              <p className="text-xs text-muted-foreground">
                Internal notes — not visible to the attendee
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 pb-8">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/events/${eventId}/registrations`)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={loading} className="min-w-[160px]">
            <Save className="mr-2 h-4 w-4" />
            {loading ? "Creating..." : "Create Registration"}
          </Button>
        </div>
      </form>
    </div>
  );
}
