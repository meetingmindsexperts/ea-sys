"use client";

import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
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
  LayoutGrid,
  List,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { formatFileSize } from "@/lib/utils";
import { useMediaView } from "@/hooks/use-media-view";

interface MediaFile {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy: { firstName: string; lastName: string };
}

// Page-size choices offered in the dropdown. The API caps `limit` at 100, so
// the largest option is the largest page the server will serve; anything
// bigger would be silently clamped and the count line would lie.
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

export default function MediaPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [view, setView] = useMediaView();

  // Server-side pagination: the API orders by createdAt desc (newest first) and
  // returns the page plus the true total. Keyed on page + size so each page is
  // its own cache entry; `["media"]` invalidations still cover every page.
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["media", page, pageSize],
    queryFn: async () => {
      const res = await fetch(`/api/media?page=${page}&limit=${pageSize}`);
      if (!res.ok) throw new Error("Failed to fetch media");
      return res.json() as Promise<{ mediaFiles: MediaFile[]; total: number; page: number; limit: number }>;
    },
    // Keep the previous page on screen while the next one loads, so paging
    // does not flash the empty state between requests.
    placeholderData: keepPreviousData,
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
      // Newest first: the upload lands at the top of page 1, so show page 1.
      setPage(1);
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

  const handleDelete = (id: string) => {
    if (!confirm("Delete this image? This cannot be undone.")) return;
    deleteMutation.mutate(id);
  };

  const mediaFiles = data?.mediaFiles ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Deleting the last item on the last page leaves `page` past the end; the
  // API then answers an empty page for a non-empty library. Adjust during
  // render (the pattern useMediaView uses) rather than in an effect, so the
  // corrected page is fetched on the very next render with no empty flash.
  if (data && page > totalPages) {
    setPage(totalPages);
  }

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

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
      ) : total === 0 ? (
        <div className="text-center py-12">
          <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-slate-50 flex items-center justify-center">
            <ImageIcon className="h-7 w-7 text-slate-400" />
          </div>
          <p className="text-sm text-slate-500">No images uploaded yet</p>
          <p className="text-xs text-slate-400 mt-1">Upload images to use in your email templates</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              {rangeStart}–{rangeEnd} of {total.toLocaleString()} image{total !== 1 ? "s" : ""}, newest first
              {isFetching && <span className="ml-2 text-primary">Refreshing…</span>}
            </p>
            <div className="flex items-center gap-0.5 rounded-md border border-slate-200 p-0.5">
              <Button
                variant={view === "grid" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setView("grid")}
                aria-label="Grid view"
                title="Grid view"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={view === "list" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setView("list")}
                aria-label="List view"
                title="List view"
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {view === "grid" ? (
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
                        onClick={() => handleDelete(media.id)}
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
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="w-12 px-3 py-2"><span className="sr-only">Preview</span></th>
                    <th className="px-3 py-2 text-left">Name</th>
                    <th className="hidden px-3 py-2 text-left sm:table-cell">Type</th>
                    <th className="hidden px-3 py-2 text-left sm:table-cell">Size</th>
                    <th className="hidden px-3 py-2 text-left md:table-cell">Uploaded</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mediaFiles.map((media) => (
                    <tr key={media.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-slate-50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={media.url} alt={media.filename} className="h-full w-full object-contain" />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className="block max-w-[220px] truncate font-medium text-slate-700 sm:max-w-[360px]" title={media.filename}>
                          {media.filename}
                        </span>
                      </td>
                      <td className="hidden px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                        {media.mimeType.replace("image/", "").toUpperCase()}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                        {formatFileSize(media.size)}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground md:table-cell">
                        {format(new Date(media.createdAt), "MMM d, yyyy")}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
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
                            variant="ghost"
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                            onClick={() => handleDelete(media.id)}
                            disabled={deleteMutation.isPending}
                            aria-label="Delete image"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination: page-size dropdown + prev/next (same shape as the contacts list) */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">Show</span>
              <select
                title="Images per page"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="h-7 text-xs border border-slate-200 rounded-md px-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/30"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              <span className="text-xs text-slate-400">per page</span>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-slate-200"
                  disabled={page === 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-3 text-xs text-slate-600 font-medium tabular-nums">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-slate-200"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
