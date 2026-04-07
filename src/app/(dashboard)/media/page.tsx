"use client";

import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ImageIcon,
  Upload,
  Trash2,
  Copy,
  Loader2,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { formatFileSize } from "@/lib/utils";

interface MediaFile {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy: { firstName: string; lastName: string };
}

export default function MediaPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["media"],
    queryFn: async () => {
      const res = await fetch("/api/media?limit=100");
      if (!res.ok) throw new Error("Failed to fetch media");
      return res.json() as Promise<{ mediaFiles: MediaFile[]; total: number }>;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/media", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
      toast.success("Image uploaded");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (mediaId: string) => {
      const res = await fetch(`/api/media/${mediaId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Delete failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media"] });
      toast.success("Image deleted");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const handleUpload = useCallback((files: FileList | null) => {
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        toast.error(`${file.name}: Only JPEG, PNG, and WebP are allowed`);
        continue;
      }
      if (file.size > 2 * 1024 * 1024) {
        toast.error(`${file.name}: File size must be under 2MB`);
        continue;
      }
      uploadMutation.mutate(file);
    }
  }, [uploadMutation]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    handleUpload(e.dataTransfer.files);
  }, [handleUpload]);

  const copyUrl = (media: MediaFile) => {
    const appUrl = window.location.origin;
    const fullUrl = media.url.startsWith("http") ? media.url : `${appUrl}${media.url}`;
    navigator.clipboard.writeText(fullUrl);
    setCopiedId(media.id);
    toast.success("URL copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const mediaFiles = data?.mediaFiles ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Media Library</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload images and copy their URLs to use in email templates.
        </p>
      </div>

      {/* Upload Zone */}
      <div
        className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
          dragActive
            ? "border-primary bg-primary/5"
            : "border-slate-200 hover:border-slate-300"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
        <div className="flex flex-col items-center gap-3">
          {uploadMutation.isPending ? (
            <Loader2 className="h-10 w-10 text-primary animate-spin" />
          ) : (
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Upload className="h-6 w-6 text-primary" />
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-slate-700">
              {uploadMutation.isPending ? "Uploading..." : "Drag and drop images here, or"}
            </p>
            {!uploadMutation.isPending && (
              <Button
                variant="link"
                className="text-primary p-0 h-auto"
                onClick={() => fileInputRef.current?.click()}
              >
                browse files
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">JPEG, PNG, or WebP. Max 2MB per file.</p>
        </div>
      </div>

      {/* Media Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : mediaFiles.length === 0 ? (
        <div className="text-center py-12">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-50 flex items-center justify-center">
            <ImageIcon className="h-7 w-7 text-slate-400" />
          </div>
          <p className="text-sm text-slate-500">No images uploaded yet</p>
          <p className="text-xs text-slate-400 mt-1">Upload images to use in your email templates</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {mediaFiles.map((media) => (
            <Card key={media.id} className="group overflow-hidden">
              <div className="aspect-1 relative bg-slate-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={media.url}
                  alt={media.filename}
                  className="w-full h-full object-contain"
                />
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 text-xs"
                    onClick={() => copyUrl(media)}
                  >
                    {copiedId === media.id ? (
                      <><Check className="h-3 w-3 mr-1" /> Copied</>
                    ) : (
                      <><Copy className="h-3 w-3 mr-1" /> Copy URL</>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-8 w-8 p-0"
                    onClick={() => {
                      if (confirm("Delete this image? This cannot be undone.")) {
                        deleteMutation.mutate(media.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              <div className="p-2">
                <p className="text-xs font-medium text-slate-700 truncate" title={media.filename}>
                  {media.filename}
                </p>
                <p className="text-[10px] text-slate-400">
                  {formatFileSize(media.size)} · {format(new Date(media.createdAt), "MMM d, yyyy")}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
