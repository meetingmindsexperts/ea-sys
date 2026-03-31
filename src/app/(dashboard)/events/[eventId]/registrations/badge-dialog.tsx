"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { IdCard, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface BadgeDialogProps {
  eventId: string;
  selectedIds: Set<string>;
  totalCount: number;
}

export function BadgeDialog({ eventId, selectedIds, totalCount }: BadgeDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleGenerate = async (mode: "selected" | "all") => {
    setLoading(true);
    try {
      const body = mode === "all"
        ? { all: true }
        : { registrationIds: Array.from(selectedIds) };

      const res = await fetch(`/api/events/${eventId}/registrations/badges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Badge generation failed");
        return;
      }

      // Open PDF in new window for printing
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const printWindow = window.open(url);
      if (printWindow) {
        printWindow.addEventListener("load", () => {
          printWindow.print();
        });
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      toast.success("Badges ready to print");
      setOpen(false);
    } catch {
      toast.error("Badge generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <IdCard className="mr-2 h-4 w-4" />
          Badges
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Print Badges</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Print badges — one per page, centered horizontally. Adjust vertical position in Event Settings.
          </p>

          <div className="space-y-2">
            {selectedIds.size > 0 && (
              <Button
                className="w-full"
                onClick={() => handleGenerate("selected")}
                disabled={loading}
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Print {selectedIds.size} Selected
              </Button>
            )}
            <Button
              variant={selectedIds.size > 0 ? "outline" : "default"}
              className="w-full"
              onClick={() => handleGenerate("all")}
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Print All ({totalCount})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
