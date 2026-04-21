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
import { useTickets } from "@/hooks/use-api";
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    ticketTypeId: string;
    paymentStatus: PaymentStatus;
    personData: PersonFormData;
    notes: string;
  }>({
    ticketTypeId: "",
    paymentStatus: PaymentStatus.UNASSIGNED,
    personData: initialPersonData,
    notes: "",
  });

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
          paymentStatus: formData.paymentStatus,
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
                  onValueChange={(value) => setFormData({ ...formData, ticketTypeId: value === "__none__" ? "" : value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No registration type (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {(ticketTypes as TicketType[]).map((regType) => (
                      <SelectItem
                        key={regType.id}
                        value={regType.id}
                        disabled={regType.soldCount >= regType.quantity}
                      >
                        {regType.name} - ${regType.price}
                        {regType.soldCount >= regType.quantity ? " (Unavailable)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Optional — leave empty to register without a type
                </p>
              </div>
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
