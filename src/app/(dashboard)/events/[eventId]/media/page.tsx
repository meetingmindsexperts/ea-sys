"use client";

import { useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
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
import { useEventMedia, useUploadEventMedia, useDeleteEventMedia, useEvent } from "@/hooks/use-api";

export default function EventMediaPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: eventData } = useEvent(eventId);
  const { data, isLoading } = useEventMedia(eventId);
  const uploadMutation = useUploadEventMedia(eventId);
  const deleteMutation = useDeleteEventMedia(eventId);

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
      const formData = new FormData();
      formData.append("file", file);
      uploadMutation.mutate(formData, {
        onSuccess: () => toast.success("Image uploaded"),
        onError: (err: Error) => toast.error(err.message),
      });
    }
  }, [uploadMutation]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    handleUpload(e.dataTransfer.files);
  }, [handleUpload]);

  const copyUrl = (media: { id: string; url: string }) => {
    const fullUrl = media.url.startsWith("http") ? media.url : `${window.location.origin}${media.url}`;
    navigator.clipboard.writeText(fullUrl);
    setCopiedId(media.id);
    toast.success("URL copied to clipboard");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const mediaFiles = data?.mediaFiles ?? [];
  const eventName = (eventData as { name?: string } | undefined)?.name;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Event Media</h1>
        {eventName && (
          <p className="text-sm text-muted-foreground mt-0.5">{eventName}</p>
        )}
        <p className="text-sm text-muted-foreground mt-1">
          Upload images for this event and copy their URLs to use in branding or email templates.
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
          <p className="text-xs text-slate-400 mt-1">Upload images to use in branding or email templates for this event</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-500">{data?.total ?? 0} image{data?.total !== 1 ? "s" : ""}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {mediaFiles.map((media: { id: string; filename: string; url: string; mimeType: string; size: number; createdAt: string }) => (
              <Card key={media.id} className="group overflow-hidden">
                <div className="aspect-square relative bg-slate-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={media.url}
                    alt={media.filename}
                    className="w-full h-full object-cover"
                  />
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
                          deleteMutation.mutate(media.id, {
                            onSuccess: () => toast.success("Image deleted"),
                            onError: (err: Error) => toast.error(err.message),
                          });
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
        </>
      )}
    </div>
  );
}
