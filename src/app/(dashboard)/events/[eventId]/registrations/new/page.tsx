"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ArrowLeft, UserPlus, Save } from "lucide-react";
import { useTickets } from "@/hooks/use-api";
import { toast } from "sonner";
import type { TicketType } from "../types";

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
  const [formData, setFormData] = useState({
    ticketTypeId: "",
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
          ticketTypeId: formData.ticketTypeId,
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
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Link
          href={`/events/${eventId}/registrations`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <UserPlus className="h-8 w-8" />
          Add Registration
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Registration Information</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ticketType">Registration Type *</Label>
              {(ticketTypes as TicketType[]).length === 0 ? (
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
                  <SelectContent>
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
                placeholder="Optional notes about this registration"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push(`/events/${eventId}/registrations`)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                <Save className="mr-2 h-4 w-4" />
                {loading ? "Creating..." : "Create Registration"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
