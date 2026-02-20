"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";

export interface PersonFormData {
  email?: string;
  firstName: string;
  lastName: string;
  organization?: string;
  jobTitle?: string;
  phone?: string;
  photo?: string | null;
  city?: string;
  country?: string;
  specialty?: string;
  tags?: string[];
  bio?: string;
  dietaryReqs?: string;
  website?: string;
}

interface PersonFormFieldsProps {
  data: PersonFormData;
  onChange: (data: PersonFormData) => void;
  disabled?: boolean;
  showBio?: boolean;
  showDietaryReqs?: boolean;
  showWebsite?: boolean;
  emailDisabled?: boolean;
  isReviewer?: boolean; // For hiding tags field from reviewers
}

export function PersonFormFields({
  data,
  onChange,
  disabled = false,
  showBio = false,
  showDietaryReqs = false,
  showWebsite = false,
  emailDisabled = false,
  isReviewer = false,
}: PersonFormFieldsProps) {
  const updateField = (field: keyof PersonFormData, value: PersonFormData[keyof PersonFormData]) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="space-y-4">
      {/* Basic Information */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="firstName">First Name *</Label>
          <Input
            id="firstName"
            value={data.firstName}
            onChange={(e) => updateField("firstName", e.target.value)}
            required
            disabled={disabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lastName">Last Name *</Label>
          <Input
            id="lastName"
            value={data.lastName}
            onChange={(e) => updateField("lastName", e.target.value)}
            required
            disabled={disabled}
          />
        </div>
      </div>

      {data.email !== undefined && (
        <div className="space-y-2">
          <Label htmlFor="email">Email *</Label>
          <Input
            id="email"
            type="email"
            value={data.email}
            onChange={(e) => updateField("email", e.target.value)}
            required
            disabled={disabled || emailDisabled}
          />
          {emailDisabled && (
            <p className="text-xs text-muted-foreground">Email cannot be changed</p>
          )}
        </div>
      )}

      {/* Professional Information */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="organization">Organization</Label>
          <Input
            id="organization"
            value={data.organization || ""}
            onChange={(e) => updateField("organization", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="jobTitle">Job Title</Label>
          <Input
            id="jobTitle"
            value={data.jobTitle || ""}
            onChange={(e) => updateField("jobTitle", e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>

      {/* Contact Information */}
      {data.phone !== undefined && (
        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            value={data.phone || ""}
            onChange={(e) => updateField("phone", e.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {/* Bio (for speakers/reviewers) */}
      {showBio && data.bio !== undefined && (
        <div className="space-y-2">
          <Label htmlFor="bio">Bio</Label>
          <Textarea
            id="bio"
            value={data.bio || ""}
            onChange={(e) => updateField("bio", e.target.value)}
            rows={4}
            placeholder="Professional biography..."
            disabled={disabled}
          />
        </div>
      )}

      {/* Website (for speakers) */}
      {showWebsite && data.website !== undefined && (
        <div className="space-y-2">
          <Label htmlFor="website">Website</Label>
          <Input
            id="website"
            type="url"
            value={data.website || ""}
            onChange={(e) => updateField("website", e.target.value)}
            placeholder="https://..."
            disabled={disabled}
          />
        </div>
      )}

      {/* Photo */}
      <div className="space-y-2">
        <Label>Photo</Label>
        <PhotoUpload
          value={data.photo || null}
          onChange={(photo) => updateField("photo", photo)}
          disabled={disabled}
        />
      </div>

      {/* Location */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            value={data.city || ""}
            onChange={(e) => updateField("city", e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <CountrySelect
            value={data.country || ""}
            onChange={(country) => updateField("country", country)}
            disabled={disabled}
          />
        </div>
      </div>

      {/* Dietary Requirements (for attendees) */}
      {showDietaryReqs && data.dietaryReqs !== undefined && (
        <div className="space-y-2">
          <Label htmlFor="dietaryReqs">Dietary Requirements</Label>
          <Input
            id="dietaryReqs"
            value={data.dietaryReqs || ""}
            onChange={(e) => updateField("dietaryReqs", e.target.value)}
            disabled={disabled}
          />
        </div>
      )}

      {/* Categorization Fields */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="specialty">Specialty</Label>
          <SpecialtySelect
            value={data.specialty || ""}
            onChange={(specialty) => updateField("specialty", specialty)}
            disabled={disabled}
          />
        </div>
        {!isReviewer && data.tags !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="tags">Tags</Label>
            <Input
              id="tags"
              value={data.tags.join(", ")}
              onChange={(e) =>
                updateField(
                  "tags",
                  e.target.value
                    .split(",")
                    .map((t) => t.trim())
                    .filter((t) => t)
                )
              }
              placeholder="e.g., VIP, Speaker, Keynote"
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">
              Add tags separated by commas
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
