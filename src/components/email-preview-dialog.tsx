"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Monitor, Smartphone } from "lucide-react";

interface EmailPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: string;
  htmlContent: string;
}

export function EmailPreviewDialog({
  open,
  onOpenChange,
  subject,
  htmlContent,
}: EmailPreviewDialogProps) {
  const [view, setView] = useState<"desktop" | "mobile">("desktop");

  const iframeWidth = view === "desktop" ? 600 : 375;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[662px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between pr-6">
            <span>Email Preview</span>
            <div className="flex items-center gap-1 rounded-lg border p-0.5">
              <Button
                type="button"
                variant={view === "desktop" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setView("desktop")}
              >
                <Monitor className="mr-1 h-3.5 w-3.5" />
                Desktop
              </Button>
              <Button
                type="button"
                variant={view === "mobile" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setView("mobile")}
              >
                <Smartphone className="mr-1 h-3.5 w-3.5" />
                Mobile
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Subject line */}
        <div className="rounded-md border bg-muted/50 px-4 py-2">
          <p className="text-xs text-muted-foreground">Subject</p>
          <p className="text-sm font-medium">{subject || "(no subject)"}</p>
        </div>

        {/* Preview area */}
        <div className="flex-1 overflow-auto rounded-lg border bg-gray-100 p-4">
          <div
            className="mx-auto bg-white shadow-md rounded-lg overflow-hidden transition-all duration-300"
            style={{ width: iframeWidth, maxWidth: "100%" }}
          >
            <iframe
              srcDoc={htmlContent}
              title="Email Preview"
              className="w-full border-0"
              style={{ height: 600, width: "100%" }}
              sandbox="allow-same-origin"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
