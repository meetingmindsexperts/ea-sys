"use client";

import { useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PersonFormFields, type PersonFormData } from "@/components/forms/person-form-fields";
import { Plus } from "lucide-react";
import { queryKeys, useEventTags } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TicketType } from "./types";
import {
  MANUAL_PAYMENT_STATUS_HELPER_TEXT,
  MANUAL_PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  type PaymentStatus,
} from "./registration-enums";

interface AddRegistrationDialogProps {
  eventId: string;
  ticketTypes: TicketType[];
}

const initialPersonData: PersonFormData = {
  email: "",
  additionalEmail: "",
  firstName: "",
  lastName: "",
  organization: "",
  jobTitle: "",
  phone: "",
  bio: "",
  photo: null,
  city: "",
  state: "",
  zipCode: "",
  country: "",
  specialty: "",
  customSpecialty: "",
  tags: [],
  dietaryReqs: "",
};

const initialFormData: {
  ticketTypeId: string;
  paymentStatus: PaymentStatus;
  personData: PersonFormData;
  notes: string;
} = {
  ticketTypeId: "",
  paymentStatus: "UNASSIGNED",
  personData: initialPersonData,
  notes: "",
};

export function AddRegistrationDialog({ eventId, ticketTypes }: AddRegistrationDialogProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState(initialFormData);
  // Feed the tag autocomplete dropdown — operator sees existing tags
  // as they type, picks one to avoid "VIP" vs "vip" duplicates.
  const tagsQuery = useEventTags(eventId);

  const createRegistration = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await fetch(`/api/events/${eventId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketTypeId: data.ticketTypeId,
          paymentStatus: data.paymentStatus,
          attendee: {
            email: data.personData.email,
            additionalEmail: data.personData.additionalEmail || undefined,
            firstName: data.personData.firstName,
            lastName: data.personData.lastName,
            organization: data.personData.organization || undefined,
            jobTitle: data.personData.jobTitle || undefined,
            phone: data.personData.phone || undefined,
            bio: data.personData.bio || undefined,
            photo: data.personData.photo || undefined,
            city: data.personData.city || undefined,
            state: data.personData.state || undefined,
            zipCode: data.personData.zipCode || undefined,
            country: data.personData.country || undefined,
            specialty: data.personData.specialty || undefined,
            customSpecialty:
              data.personData.specialty === "Others"
                ? data.personData.customSpecialty || undefined
                : undefined,
            tags: data.personData.tags && data.personData.tags.length > 0 ? data.personData.tags : undefined,
            dietaryReqs: data.personData.dietaryReqs || undefined,
          },
          notes: data.notes || undefined,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create registration");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.registrations(eventId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
      setDialogOpen(false);
      setFormData(initialFormData);
      setFormError(null);
      toast.success("Registration created successfully");
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    createRegistration.mutate(formData);
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Registration
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Add New Registration</DialogTitle>
          <DialogDescription>
            Register a new attendee for this event
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="ticketType">Registration Type *</Label>
              {ticketTypes.length === 0 ? (
                <p className="text-sm text-muted-foreground p-3 bg-muted rounded">
                  No registration types available. Please create a registration type first.
                </p>
              ) : (
                <Select
                  value={formData.ticketTypeId}
                  onValueChange={(value) => {
                    // Auto-default a free ticket to COMPLIMENTARY (no Stripe
                    // charge), reverting that auto-default when switching to a
                    // paid type. Explicit admin choices (PAID/UNPAID/INCLUSIVE)
                    // are preserved. This dialog has no tier picker, so "free"
                    // = base price 0 with no active tiers.
                    const tt = ticketTypes.find((t) => t.id === value);
                    const hasActiveTiers = (tt?.pricingTiers ?? []).some((t) => t.isActive);
                    const isFree = !!tt && !hasActiveTiers && Number(tt.price) === 0;
                    setFormData((prev) => ({
                      ...prev,
                      ticketTypeId: value,
                      paymentStatus: isFree
                        ? "COMPLIMENTARY"
                        : prev.paymentStatus === "COMPLIMENTARY"
                          ? "UNASSIGNED"
                          : prev.paymentStatus,
                    }));
                  }}
                  required
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a registration type" />
                  </SelectTrigger>
                  <SelectContent className="z-[100]">
                    {ticketTypes.map((regType) => {
                      // Hide the "- $X" suffix when the type has active
                      // pricing tiers (the Pricing Tier dropdown is the
                      // source of truth) or when the base price is 0
                      // (avoids misleading "$0" on free/tier-priced types).
                      const hasActiveTiers = (regType.pricingTiers ?? []).some(
                        (t) => t.isActive
                      );
                      const showPrice = !hasActiveTiers && regType.price > 0;
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
              )}
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
                <SelectContent className="z-[100]">
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

            <PersonFormFields
              data={formData.personData}
              onChange={(personData) => setFormData({ ...formData, personData })}
              showBio={true}
              showDietaryReqs={true}
              tagSuggestions={(tagsQuery.data?.tags ?? []).map((t) => t.tag)}
            />

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              />
            </div>

            {formError && (
              <div className="text-sm text-red-600 bg-red-50 p-3 rounded">
                {formError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createRegistration.isPending}>
              {createRegistration.isPending ? "Creating..." : "Create Registration"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
