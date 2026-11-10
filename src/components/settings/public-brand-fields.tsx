"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Upload, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The attendee-facing brand (src/lib/public-brand.ts): what HCPs see on the
 * sign-in pages, the catalogue, the event pages, their portal and the kiosk.
 * Either half left empty falls back to the organisation's own name or logo.
 */
export function PublicBrandFields({
  name,
  logo,
  orgName,
  disabled,
  onChange,
}: {
  name: string;
  logo: string | null;
  orgName: string;
  disabled: boolean;
  onChange: (next: { publicName?: string; publicLogo?: string | null }) => void;
}) {
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    if (file.size > 500 * 1024) {
      toast.error("Logo must be under 500KB");
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload/photo", { method: "POST", body: formData });
      if (!res.ok) {
        console.error("settings:public-logo-upload-failed", res.status);
        toast.error("Failed to upload logo");
        return;
      }
      const { url } = await res.json();
      onChange({ publicLogo: url });
      toast.success("Logo uploaded. Save to apply it.");
    } catch (err) {
      console.error("settings:public-logo-upload-failed", err);
      toast.error("Failed to upload logo");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">Attendee-facing brand</h3>
        <p className="text-xs text-muted-foreground">
          What attendees, authors and reviewers see: the sign-in pages, the catalogue, event pages, their portal and
          the check-in kiosk. Staff screens and invoices keep the organisation&apos;s name and logo above.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="public-brand-name">Name</Label>
          <Input
            id="public-brand-name"
            value={name}
            maxLength={120}
            disabled={disabled}
            placeholder={orgName || "Organisation name"}
            onChange={(e) => onChange({ publicName: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Leave empty to use the organisation name.</p>
        </div>
        <div className="space-y-2">
          <Label>Logo</Label>
          <div className="flex items-center gap-4">
            {logo ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo} alt="Attendee-facing logo" className="h-12 w-auto max-w-[140px] rounded border p-1 object-contain" />
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onChange({ publicLogo: null })}
                    className="absolute -top-2 -right-2 rounded-full bg-destructive p-0.5 text-white"
                    aria-label="Remove attendee-facing logo"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                )}
              </div>
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded border border-dashed text-muted-foreground">
                <Upload className="h-5 w-5" />
              </div>
            )}
            {!disabled && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => document.getElementById("public-logo-upload")?.click()}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {uploading ? "Uploading..." : "Upload logo"}
                </Button>
                <input
                  id="public-logo-upload"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="Upload attendee-facing logo"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void upload(file);
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">Leave empty to use the organisation logo.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
