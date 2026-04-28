"use client";

/**
 * MediaPickerDialog — reusable media-library picker.
 *
 * Wraps the existing org-scoped `/api/media` endpoints (list / upload).
 * On select, calls `onSelect(url)` with the public `/uploads/media/...`
 * URL of the chosen file.
 *
 * Designed for Tiptap's "Insert Image" toolbar button (replacing the
 * legacy `window.prompt()` URL paste), but kept generic enough for
 * any caller that needs to drop an image-input into a form.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, Upload, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface MediaFile {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
}

interface ApiResponse {
  mediaFiles: MediaFile[];
  total: number;
}

interface MediaPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen file's public URL. */
  onSelect: (url: string) => void;
}

export function MediaPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: MediaPickerDialogProps) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/media?limit=100");
      if (!res.ok) {
        toast.error("Failed to load media");
        return;
      }
      const data = (await res.json()) as ApiResponse;
      setFiles(data.mediaFiles ?? []);
    } catch {
      toast.error("Failed to load media");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchFiles();
  }, [open, fetchFiles]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/media", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Upload failed");
        return;
      }
      const uploaded = (await res.json()) as MediaFile;
      // Auto-select the newly uploaded file — saves the user a click.
      onSelect(uploaded.url);
      onOpenChange(false);
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    // Reset so the same file can be re-uploaded if needed.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handlePick = (file: MediaFile) => {
    onSelect(file.url);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Insert Image</DialogTitle>
          <DialogDescription>
            Choose from your media library or upload a new image. JPEG, PNG, or WebP. Max 2MB.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Upload zone */}
          <div className="border-2 border-dashed rounded-lg p-6 text-center">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload new image
                </>
              )}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Or pick from existing media below.
            </p>
          </div>

          {/* Existing media grid */}
          {loading ? (
            <div className="flex items-center justify-center h-40 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading...
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <ImageIcon className="h-8 w-8 mb-2" />
              <p className="text-sm">No media yet — upload an image to get started.</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => handlePick(file)}
                  className="aspect-square border rounded-lg overflow-hidden hover:border-primary hover:ring-2 hover:ring-primary/20 transition-all bg-muted"
                  title={file.filename}
                >
                  <Image
                    src={file.url}
                    alt={file.filename}
                    width={150}
                    height={150}
                    className="w-full h-full object-cover"
                    unoptimized
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
