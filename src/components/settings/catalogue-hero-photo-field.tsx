"use client";

import { useState } from "react";
import { ImageIcon, Upload, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useCan } from "@/hooks/use-can";

/**
 * The public catalogue's hero photo (Nov 5, 2026), in Settings, General. The
 * photo sits behind the catalogue's headline under a navy wash, so any
 * conference photo reads; without one the page draws its own pattern. Saved
 * with the rest of the organisation settings, as `settings.catalogueHeroImage`.
 *
 * Uploads go to the organisation's media library (2 MB), not the 500 KB
 * photo route the logo uses: a full-width photo needs the room.
 */

const MAX_BYTES = 2 * 1024 * 1024;

function uploadLabel(uploading: boolean, value: string | null): string {
  if (uploading) return "Uploading...";
  return value ? "Replace photo" : "Upload photo";
}

export function CatalogueHeroPhotoField({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  disabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  // The upload goes to the media library, a key of its own: a custom role
  // with org.settings alone can remove the photo but not upload one.
  const canUpload = useCan("media.library.manage") === "allowed";

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error("The photo must be under 2 MB. Export it at about 2400 pixels wide.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/media", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("settings:catalogue-hero-upload-failed", res.status, body);
        toast.error(body.error ?? "Couldn't upload the photo. Please try again.");
        return;
      }
      const { url } = await res.json();
      onChange(url);
      toast.success("Photo uploaded. Save to publish it on the catalogue.");
    } catch (err) {
      console.error("settings:catalogue-hero-upload-failed", err);
      toast.error("Couldn't upload the photo. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label>Event catalogue photo</Label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="relative aspect-[16/7] w-full max-w-xs overflow-hidden rounded-md border bg-[#0a1c2e]">
          {value ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={value} alt="Event catalogue photo" className="h-full w-full object-cover" />
              <div className="absolute inset-0 bg-[linear-gradient(100deg,rgb(10_28_46/0.9)_0%,rgb(10_28_46/0.55)_70%)]" />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-white/60">
              <ImageIcon className="h-6 w-6" />
            </div>
          )}
          {value && !disabled && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="absolute right-1.5 top-1.5 rounded-full bg-destructive p-0.5 text-white"
              aria-label="Remove the catalogue photo"
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {!disabled && canUpload && (
            <>
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => document.getElementById("catalogue-hero-upload")?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                {uploadLabel(uploading, value)}
              </Button>
              <input
                id="catalogue-hero-upload"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label="Upload the event catalogue photo"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void upload(file);
                }}
              />
            </>
          )}
          <p className="max-w-sm text-xs text-muted-foreground">
            Shown behind the headline of the public event catalogue, darkened so the text stays readable. A landscape photo
            from one of your conferences, about 2400 pixels wide, JPEG under 2 MB. Without one, the catalogue shows a pattern.
          </p>
        </div>
      </div>
    </div>
  );
}
