"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  MAX_MANUAL_ATTACHMENTS,
  MAX_MANUAL_ATTACHMENTS_TOTAL_BYTES,
  MANUAL_ATTACHMENT_ACCEPT,
  resolveAttachmentMime,
} from "@/lib/email-attachment-limits";

interface EmailAttachmentPickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** Optional label above the picker. */
  label?: string;
}

/**
 * Controlled picker for manual PDF/DOC/DOCX email attachments. The parent owns
 * the `File[]`; on send it converts each via `fileToBase64` + `resolveAttachmentMime`.
 * Client-side validation (type / count / total size) mirrors the server
 * validator so the operator gets an instant, matching error; the server
 * re-validates by magic bytes regardless.
 */
export function EmailAttachmentPicker({ files, onChange, disabled, label = "Attachments (optional)" }: EmailAttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const next = [...files];
    let running = totalBytes;

    for (const file of Array.from(incoming)) {
      if (next.length >= MAX_MANUAL_ATTACHMENTS) {
        toast.error(`You can attach at most ${MAX_MANUAL_ATTACHMENTS} files.`);
        break;
      }
      if (!resolveAttachmentMime(file)) {
        toast.error(`"${file.name}" is not a PDF, DOC, or DOCX file.`);
        continue;
      }
      if (running + file.size > MAX_MANUAL_ATTACHMENTS_TOTAL_BYTES) {
        toast.error("Attachments exceed the 10 MB total limit.");
        continue;
      }
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue; // skip dupes
      next.push(file);
      running += file.size;
    }

    onChange(next);
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = (index: number) => onChange(files.filter((_, i) => i !== index));

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={MANUAL_ATTACHMENT_ACCEPT}
        className="hidden"
        aria-label="Attach files"
        onChange={(e) => addFiles(e.target.files)}
      />

      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-1.5 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span>
              </span>
              <button
                type="button"
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove ${file.name}`}
                className="ml-2 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || files.length >= MAX_MANUAL_ATTACHMENTS}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          {files.length === 0 ? "Attach files" : "Add more"}
        </Button>
        <span className="text-xs text-muted-foreground">
          PDF, DOC, DOCX · max {MAX_MANUAL_ATTACHMENTS} files, 10 MB total
          {totalBytes > 0 && ` · ${(totalBytes / (1024 * 1024)).toFixed(1)} MB used`}
        </span>
      </div>
    </div>
  );
}
