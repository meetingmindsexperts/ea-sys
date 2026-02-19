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
import { queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TicketType } from "./types";

interface AddRegistrationDialogProps {
  eventId: string;
  ticketTypes: TicketType[];
}

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

const initialFormData = {
  ticketTypeId: "",
  personData: initialPersonData,
  notes: "",
};

export function AddRegistrationDialog({ eventId, ticketTypes }: AddRegistrationDialogProps) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState(initialFormData);

  const createRegistration = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await fetch(`/api/events/${eventId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketTypeId: data.ticketTypeId,
          attendee: {
            email: data.personData.email,
            firstName: data.personData.firstName,
            lastName: data.personData.lastName,
            organization: data.personData.organization || undefined,
            jobTitle: data.personData.jobTitle || undefined,
            phone: data.personData.phone || undefined,
            photo: data.personData.photo || undefined,
            city: data.personData.city || undefined,
            country: data.personData.country || undefined,
            specialty: data.personData.specialty || undefined,
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
                  onValueChange={(value) => setFormData({ ...formData, ticketTypeId: value })}
                  required
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a registration type" />
                  </SelectTrigger>
                  <SelectContent className="z-[100]">
                    {ticketTypes.map((regType) => (
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
              )}
            </div>

            <PersonFormFields
              data={formData.personData}
              onChange={(personData) => setFormData({ ...formData, personData })}
              showDietaryReqs={true}
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
