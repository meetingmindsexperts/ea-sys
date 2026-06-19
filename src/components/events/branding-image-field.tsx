"use client";

import { useState } from "react";
import Image from "next/image";
import { ImagePlus, Trash2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MediaPickerDialog } from "@/components/media/media-picker-dialog";

interface BrandingImageFieldProps {
  /** Scopes upload + browse to this event's media library. */
  eventId: string;
  label: string;
  /** Current image URL ("" when unset). */
  value: string;
  /** Receives the chosen/uploaded URL, or "" when removed. */
  onChange: (url: string) => void;
  hint?: React.ReactNode;
  /** Class on the preview <Image> (per-field aspect/height). */
  previewClassName?: string;
  /** Class on the preview wrapper (e.g. width cap "max-w-[600px]"). */
  previewWrapClassName?: string;
}

/**
 * Single-image branding control: shows the current image, lets the organizer
 * upload a new one OR pick from this event's media library (via
 * MediaPickerDialog scoped by `eventId`), and remove. Uploading here goes
 * through `/api/events/[eventId]/media`, so the image also appears in the
 * event's media library. Produces a plain URL string for the existing
 * branding save flow — no backend change.
 */
export function BrandingImageField({
  eventId,
  label,
  value,
  onChange,
  hint,
  previewClassName = "w-full h-48 object-contain",
  previewWrapClassName = "",
}: BrandingImageFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="space-y-2">
      <Label>{label}</Label>

      {value && (
        <div className={`border rounded-lg overflow-hidden ${previewWrapClassName}`}>
          <Image
            src={value}
            alt={`${label} preview`}
            width={1200}
            height={400}
            className={previewClassName}
            unoptimized
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
          <ImagePlus className="mr-2 h-4 w-4" />
          {value ? "Change image" : "Upload or choose image"}
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => onChange("")}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            Remove
          </Button>
        )}
      </div>

      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}

      <MediaPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        eventId={eventId}
        title={`Choose ${label.toLowerCase()}`}
        onSelect={(url) => onChange(url)}
      />
    </div>
  );
}
