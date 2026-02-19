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
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { Plus } from "lucide-react";
import { queryKeys } from "@/hooks/use-api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TicketType } from "./types";

interface AddRegistrationDialogProps {
  eventId: string;
  ticketTypes: TicketType[];
}

const initialFormData = {
  ticketTypeId: "",
  email: "",
  firstName: "",
  lastName: "",
  organization: "",
  jobTitle: "",
  phone: "",
  photo: null as string | null,
  city: "",
  country: "",
  specialty: "",
  tags: [] as string[],
  dietaryReqs: "",
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
            email: data.email,
            firstName: data.firstName,
            lastName: data.lastName,
            organization: data.organization || undefined,
            jobTitle: data.jobTitle || undefined,
            phone: data.phone || undefined,
            photo: data.photo || undefined,
            city: data.city || undefined,
            country: data.country || undefined,
            dietaryReqs: data.dietaryReqs || undefined,
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
      <DialogContent className="max-w-3xl">
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

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name *</Label>
                <Input
                  id="firstName"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name *</Label>
                <Input
                  id="lastName"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="organization">Organization</Label>
                <Input
                  id="organization"
                  value={formData.organization}
                  onChange={(e) => setFormData({ ...formData, organization: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jobTitle">Job Title</Label>
                <Input
                  id="jobTitle"
                  value={formData.jobTitle}
                  onChange={(e) => setFormData({ ...formData, jobTitle: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dietaryReqs">Dietary Requirements</Label>
                <Input
                  id="dietaryReqs"
                  value={formData.dietaryReqs}
                  onChange={(e) => setFormData({ ...formData, dietaryReqs: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <CountrySelect
                  value={formData.country}
                  onChange={(country) => setFormData({ ...formData, country })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Photo</Label>
              <PhotoUpload
                value={formData.photo}
                onChange={(photo) => setFormData({ ...formData, photo })}
              />
            </div>

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
