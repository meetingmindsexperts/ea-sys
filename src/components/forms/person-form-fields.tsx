"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import { TagInput } from "@/components/ui/tag-input";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";

export interface PersonFormData {
  title?: string | null;
  role?: string;
  email?: string;
  additionalEmail?: string;
  firstName: string;
  lastName: string;
  organization?: string;
  jobTitle?: string;
  phone?: string;
  photo?: string | null;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  specialty?: string;
  customSpecialty?: string;
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
  /** Role dropdown (RoleSelect — AttendeeRole profession category). Off by
   *  default; enabled on the registration + speaker + contact add forms. */
  showRole?: boolean;
  emailDisabled?: boolean;
  isReviewer?: boolean; // For hiding tags field from reviewers
  /**
   * Existing tags pool surfaced as an autocomplete dropdown on the
   * tags field. Prevents operator-typed duplicates ("VIP" vs "vip").
   * Source depends on the host form:
   *   - Add Registration form  → useEventTags(eventId).map(t => t.tag)
   *   - Add Speaker form       → useEventSpeakerTags(eventId).tags.map(t => t.tag)
   *   - Add Contact form       → useContactTags().data.tags
   * Pass undefined or [] to disable suggestions; the field then
   * behaves exactly like the pre-feature version.
   */
  tagSuggestions?: string[];
}

export function PersonFormFields({
  data,
  onChange,
  disabled = false,
  showBio = false,
  showDietaryReqs = false,
  showWebsite = false,
  showRole = false,
  emailDisabled = false,
  isReviewer = false,
  tagSuggestions,
}: PersonFormFieldsProps) {
  const updateField = (field: keyof PersonFormData, value: PersonFormData[keyof PersonFormData]) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="space-y-4">
      {/* Title + Name */}
      <div className="grid grid-cols-[100px_1fr_1fr] gap-4">
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <TitleSelect
            value={data.title}
            onChange={(title) => updateField("title", title)}
            disabled={disabled}
          />
        </div>
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

      {/* Email + Additional Email */}
      {(data.email !== undefined || data.additionalEmail !== undefined) && (
        <div className="grid grid-cols-2 gap-4">
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
          {data.additionalEmail !== undefined && (
            <div className="space-y-2">
              <Label htmlFor="additionalEmail">Additional Email</Label>
              <Input
                id="additionalEmail"
                type="email"
                value={data.additionalEmail || ""}
                onChange={(e) => updateField("additionalEmail", e.target.value)}
                placeholder="Secondary / CC email (optional)"
                disabled={disabled}
              />
            </div>
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

      {/* Bio (for speakers/reviewers/attendees) */}
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
        {data.state !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="state">State / Province</Label>
            <Input
              id="state"
              value={data.state || ""}
              onChange={(e) => updateField("state", e.target.value)}
              disabled={disabled}
            />
          </div>
        )}
        {data.zipCode !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="zipCode">Zip / Postal Code</Label>
            <Input
              id="zipCode"
              value={data.zipCode || ""}
              onChange={(e) => updateField("zipCode", e.target.value)}
              disabled={disabled}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <CountrySelect
            value={data.country || ""}
            onChange={(country) => updateField("country", country)}
            disabled={disabled}
          />
        </div>
      </div>

      {/* Role + Specialty (side by side) + Custom Specialty (when "Others") */}
      <div className="grid grid-cols-2 gap-4">
        {showRole && data.role !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <RoleSelect
              value={data.role}
              onChange={(role) => updateField("role", role)}
              placeholder="Select a role (optional)"
              disabled={disabled}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="specialty">Specialty</Label>
          <SpecialtySelect
            value={data.specialty || ""}
            onChange={(specialty) =>
              onChange({
                ...data,
                specialty,
                // Auto-clear customSpecialty when specialty moves away from
                // "Others" — mirrors the public register-form UX so stale
                // free-text never lingers. Only touch the field if the host
                // tracks it (data.customSpecialty !== undefined).
                ...(data.customSpecialty !== undefined
                  ? { customSpecialty: specialty === "Others" ? data.customSpecialty : "" }
                  : {}),
              })
            }
            disabled={disabled}
          />
        </div>
        {data.customSpecialty !== undefined && data.specialty === "Others" && (
          <div className="space-y-2">
            <Label htmlFor="customSpecialty">Custom Specialty *</Label>
            <Input
              id="customSpecialty"
              value={data.customSpecialty || ""}
              onChange={(e) => updateField("customSpecialty", e.target.value)}
              placeholder="Specify..."
              required
              disabled={disabled}
            />
          </div>
        )}
      </div>

      {/* Dietary Requirements (attendees) */}
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

      {/* Tags */}
      {!isReviewer && data.tags !== undefined && (
        <div className="space-y-2">
          <Label>Tags</Label>
          <TagInput
            value={data.tags}
            onChange={(tags) => updateField("tags", tags)}
            placeholder="Type a tag and press Enter or comma"
            disabled={disabled}
            suggestions={tagSuggestions}
          />
        </div>
      )}
    </div>
  );
}
