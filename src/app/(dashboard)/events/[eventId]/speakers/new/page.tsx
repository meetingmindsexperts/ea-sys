"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { RegistrationTypeSelect } from "@/components/ui/registration-type-select";
import { ArrowLeft, Mic, Save, User, Briefcase, MapPin, Tag, Share2 } from "lucide-react";
import { toast } from "sonner";

export default function NewSpeakerPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
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
    photo: null as string | null,
    city: "",
    state: "",
    zipCode: "",
    country: "",
    specialty: "",
    customSpecialty: "",
    tags: [] as string[],
    status: "INVITED",
    registrationType: "",
    socialLinks: {
      twitter: "",
      linkedin: "",
      github: "",
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Strip fields that Zod would reject on empty string. `role` and
    // `title` are enum-typed on the backend — empty string isn't in the
    // enum set. Other optional strings pass through as-is.
    const payload = {
      ...formData,
      role: formData.role || undefined,
      title: formData.title || undefined,
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
        {/* Section 1: Personal Information */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Personal Information</CardTitle>
            </div>
            <CardDescription>
              Name, email, and profile photo
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 grid-cols-[100px_1fr_1fr]">
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <TitleSelect
                  value={formData.title}
                  onChange={(title) => setFormData({ ...formData, title })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name *</Label>
                <Input
                  id="firstName"
                  value={formData.firstName}
                  onChange={(e) =>
                    setFormData({ ...formData, firstName: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name *</Label>
                <Input
                  id="lastName"
                  value={formData.lastName}
                  onChange={(e) =>
                    setFormData({ ...formData, lastName: e.target.value })
                  }
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <RoleSelect
                value={formData.role}
                onChange={(role) => setFormData({ ...formData, role })}
                placeholder="Select a role (optional)"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="additionalEmail">Additional Email</Label>
                <Input
                  id="additionalEmail"
                  type="email"
                  value={formData.additionalEmail}
                  onChange={(e) =>
                    setFormData({ ...formData, additionalEmail: e.target.value })
                  }
                  placeholder="Secondary / CC email (optional)"
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
          </CardContent>
        </Card>

        {/* Section 2: Professional Details */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Professional Details</CardTitle>
            </div>
            <CardDescription>
              Organization, role, and biography
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="organization">Organization</Label>
                <Input
                  id="organization"
                  value={formData.organization}
                  onChange={(e) =>
                    setFormData({ ...formData, organization: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jobTitle">Job Title</Label>
                <Input
                  id="jobTitle"
                  value={formData.jobTitle}
                  onChange={(e) =>
                    setFormData({ ...formData, jobTitle: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="bio">Bio</Label>
              <Textarea
                id="bio"
                value={formData.bio}
                onChange={(e) =>
                  setFormData({ ...formData, bio: e.target.value })
                }
                rows={4}
                placeholder="Speaker's biography..."
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="specialty">Specialty</Label>
                <SpecialtySelect
                  value={formData.specialty}
                  onChange={(specialty) =>
                    setFormData({
                      ...formData,
                      specialty,
                      // Auto-clear customSpecialty when specialty moves away
                      // from "Others" — mirrors the public register-form
                      // UX. Prevents stale free-text from lingering in DB.
                      customSpecialty: specialty === "Others" ? formData.customSpecialty : "",
                    })
                  }
                />
              </div>
              {formData.specialty === "Others" && (
                <div className="space-y-2">
                  <Label htmlFor="customSpecialty">Custom Specialty *</Label>
                  <Input
                    id="customSpecialty"
                    value={formData.customSpecialty}
                    onChange={(e) =>
                      setFormData({ ...formData, customSpecialty: e.target.value })
                    }
                    placeholder="Specify..."
                    required
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                type="url"
                value={formData.website}
                onChange={(e) =>
                  setFormData({ ...formData, website: e.target.value })
                }
                placeholder="https://..."
              />
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Location */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Location</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={(e) =>
                    setFormData({ ...formData, city: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="state">State / Province</Label>
                <Input
                  id="state"
                  value={formData.state}
                  onChange={(e) =>
                    setFormData({ ...formData, state: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zipCode">Zip / Postal Code</Label>
                <Input
                  id="zipCode"
                  value={formData.zipCode}
                  onChange={(e) =>
                    setFormData({ ...formData, zipCode: e.target.value })
                  }
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
          </CardContent>
        </Card>

        {/* Section 4: Status & Classification */}
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <Tag className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Status & Classification</CardTitle>
            </div>
            <CardDescription>
              Invitation status, registration type, and tags
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

            <div className="space-y-2">
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                value={formData.tags.join(", ")}
                onChange={(e) =>
                  setFormData({ ...formData, tags: e.target.value.split(",").map(t => t.trim()).filter(t => t) })
                }
                placeholder="e.g., Keynote, Panelist, VIP"
              />
              <p className="text-xs text-muted-foreground">Separate tags with commas</p>
            </div>
          </CardContent>
        </Card>

        {/* Section 5: Social Links */}
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
                      socialLinks: {
                        ...formData.socialLinks,
                        twitter: e.target.value,
                      },
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
                      socialLinks: {
                        ...formData.socialLinks,
                        linkedin: e.target.value,
                      },
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
                      socialLinks: {
                        ...formData.socialLinks,
                        github: e.target.value,
                      },
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
