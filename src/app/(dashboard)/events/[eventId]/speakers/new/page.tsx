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
import { RegistrationTypeSelect } from "@/components/ui/registration-type-select";
import { PersonFormFields, type PersonFormData } from "@/components/forms/person-form-fields";
import { useEventSpeakerTags } from "@/hooks/use-api";
import { ArrowLeft, Mic, Save, User, Tag, Share2 } from "lucide-react";
import { toast } from "sonner";

export default function NewSpeakerPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Feed the tag autocomplete from the event's existing speaker tags —
  // same source the bulk-tag dialog uses, so the operator sees a
  // consistent set across entry points.
  const speakerTagsQuery = useEventSpeakerTags(eventId);
  const [formData, setFormData] = useState<{
    personData: PersonFormData;
    status: string;
    registrationType: string;
    socialLinks: { twitter: string; linkedin: string; github: string };
  }>({
    personData: {
      title: "",
      role: "",
      email: "",
      additionalEmail: "",
      firstName: "",
      lastName: "",
      bio: "",
      organization: "",
      jobTitle: "",
      website: "",
      phone: "",
      photo: null,
      city: "",
      state: "",
      zipCode: "",
      country: "",
      specialty: "",
      customSpecialty: "",
      tags: [],
    },
    status: "INVITED",
    registrationType: "",
    socialLinks: { twitter: "", linkedin: "", github: "" },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const p = formData.personData;
    // Strip fields that Zod would reject on empty string. `role` and
    // `title` are enum-typed on the backend — empty string isn't in the
    // enum set. Other optional strings pass through as-is.
    const payload = {
      title: p.title || undefined,
      role: p.role || undefined,
      email: p.email,
      additionalEmail: p.additionalEmail || undefined,
      firstName: p.firstName,
      lastName: p.lastName,
      bio: p.bio || undefined,
      organization: p.organization || undefined,
      jobTitle: p.jobTitle || undefined,
      website: p.website || undefined,
      phone: p.phone || undefined,
      photo: p.photo || undefined,
      city: p.city || undefined,
      state: p.state || undefined,
      zipCode: p.zipCode || undefined,
      country: p.country || undefined,
      specialty: p.specialty || undefined,
      // Only meaningful when specialty is "Others"; the shared component
      // auto-clears it otherwise, but guard here too as a last line.
      customSpecialty:
        p.specialty === "Others" ? p.customSpecialty || undefined : undefined,
      tags: p.tags && p.tags.length > 0 ? p.tags : undefined,
      status: formData.status,
      registrationType: formData.registrationType || undefined,
      socialLinks: formData.socialLinks,
    };

    try {
      const res = await fetch(`/api/events/${eventId}/speakers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success("Speaker added successfully");
        router.push(`/events/${eventId}/speakers`);
      } else {
        const data = await res.json().catch(() => ({}));
        // Zod validation failures include `details.fieldErrors` — surface
        // them instead of the bare "Invalid input" so the user knows
        // which field is broken. Fall back to the code/message / generic
        // error if the response isn't Zod-shaped.
        const fieldErrors = data?.details?.fieldErrors as
          | Record<string, string[] | undefined>
          | undefined;
        const formErrors = data?.details?.formErrors as string[] | undefined;
        const perFieldLines = fieldErrors
          ? Object.entries(fieldErrors)
              .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
              .map(([field, msgs]) => `${field}: ${(msgs as string[]).join(", ")}`)
          : [];
        const formLines = formErrors ?? [];
        const detailLines = [...perFieldLines, ...formLines];
        const message =
          detailLines.length > 0
            ? `${data.error ?? "Invalid input"} — ${detailLines.join("; ")}`
            : data.code
              ? `${data.error ?? "Failed to create speaker"} (${data.code})`
              : data.error || "Failed to create speaker";
        console.error("[speaker-create] server rejected payload", {
          status: res.status,
          error: data.error,
          code: data.code,
          fieldErrors,
          formErrors,
        });
        setError(message);
      }
    } catch (err) {
      console.error("[speaker-create] network or unexpected error", err);
      setError(err instanceof Error ? err.message : "An error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link
          href={`/events/${eventId}/speakers`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Speakers
        </Link>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300 flex items-center justify-center shrink-0">
            <Mic className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add Speaker</h1>
            <p className="text-sm text-muted-foreground">
              Add a new speaker to your event
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
        {/* Section 1: Personal & Professional Details (shared with Add Registration) */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Personal Details</CardTitle>
            </div>
            <CardDescription>
              Name, contact, professional info, location, and photo
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PersonFormFields
              data={formData.personData}
              onChange={(personData) => setFormData({ ...formData, personData })}
              showBio
              showWebsite
              showRole
              tagSuggestions={(speakerTagsQuery.data?.tags ?? []).map((t) => t.tag)}
            />
          </CardContent>
        </Card>

        {/* Section 2: Status & Classification */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Status & Classification</CardTitle>
            </div>
            <CardDescription>
              Invitation status and registration type
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={formData.status}
                  onValueChange={(value) =>
                    setFormData({ ...formData, status: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INVITED">Invited</SelectItem>
                    <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                    <SelectItem value="DECLINED">Declined</SelectItem>
                    <SelectItem value="CANCELLED">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="registrationType">Registration Type</Label>
                <RegistrationTypeSelect
                  value={formData.registrationType}
                  onChange={(registrationType) =>
                    setFormData({ ...formData, registrationType })
                  }
                  eventId={eventId}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Social Links */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Social Links</CardTitle>
            </div>
            <CardDescription>
              Optional social media profiles
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="twitter">Twitter</Label>
                <Input
                  id="twitter"
                  value={formData.socialLinks.twitter}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      socialLinks: { ...formData.socialLinks, twitter: e.target.value },
                    })
                  }
                  placeholder="@username"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="linkedin">LinkedIn</Label>
                <Input
                  id="linkedin"
                  value={formData.socialLinks.linkedin}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      socialLinks: { ...formData.socialLinks, linkedin: e.target.value },
                    })
                  }
                  placeholder="Profile URL"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="github">GitHub</Label>
                <Input
                  id="github"
                  value={formData.socialLinks.github}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      socialLinks: { ...formData.socialLinks, github: e.target.value },
                    })
                  }
                  placeholder="@username"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 pb-8">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(`/events/${eventId}/speakers`)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={loading} className="min-w-[140px]">
            <Save className="mr-2 h-4 w-4" />
            {loading ? "Saving..." : "Add Speaker"}
          </Button>
        </div>
      </form>
    </div>
  );
}
