"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateScheduledEmail, type ScheduledEmailItem } from "@/hooks/use-api";

interface Props {
  eventId: string;
  scheduledEmail: ScheduledEmailItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MIN_LEAD_MS = 5 * 60 * 1000;

function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function computeMinScheduledFor(): string {
  const d = new Date(Date.now() + MIN_LEAD_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isAtLeastMinLeadTime(when: Date): boolean {
  return when.getTime() >= Date.now() + MIN_LEAD_MS;
}

export function ScheduledEmailEditDialog({ eventId, scheduledEmail, open, onOpenChange }: Props) {
  // Mount/unmount the inner form when the row changes so useState initializers re-run.
  // This avoids setState-in-effect anti-pattern.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {scheduledEmail ? (
        <EditDialogContent
          key={scheduledEmail.id}
          eventId={eventId}
          scheduledEmail={scheduledEmail}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

interface InnerProps {
  eventId: string;
  scheduledEmail: ScheduledEmailItem;
  onClose: () => void;
}

function EditDialogContent({ eventId, scheduledEmail, onClose }: InnerProps) {
  const updateMutation = useUpdateScheduledEmail(eventId);
  const [customSubject, setCustomSubject] = useState(scheduledEmail.customSubject ?? "");
  const [customMessage, setCustomMessage] = useState(scheduledEmail.customMessage ?? "");
  const [scheduledFor, setScheduledFor] = useState(toLocalDateTimeInput(scheduledEmail.scheduledFor));
  const [minScheduledFor] = useState(() => computeMinScheduledFor());

  const handleSave = async () => {

    if (!scheduledFor) {
      toast.error("Please pick a date and time");
      return;
    }
    const when = new Date(scheduledFor);
    if (!isAtLeastMinLeadTime(when)) {
      toast.error("Scheduled time must be at least 5 minutes in the future");
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: scheduledEmail.id,
        customSubject: customSubject.trim() || null,
        customMessage: customMessage.trim() || null,
        scheduledFor: when.toISOString(),
      });
      toast.success("Scheduled email updated");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const isCustom = scheduledEmail.emailType === "custom";

  return (
    <DialogContent className="sm:max-w-[525px]">
      <DialogHeader>
        <DialogTitle>Edit Scheduled Email</DialogTitle>
        <DialogDescription>
          Update the subject, message, or send time. Recipient filters cannot be edited — cancel
          and create a new scheduled email if you need to change the audience.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {isCustom && (
          <div className="space-y-2">
            <Label htmlFor="edit-subject">Subject</Label>
            <Input
              id="edit-subject"
              value={customSubject}
              onChange={(e) => setCustomSubject(e.target.value)}
              maxLength={500}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="edit-message">
            {isCustom ? "Message" : "Personal Message (optional)"}
          </Label>
          <Textarea
            id="edit-message"
            value={customMessage}
            onChange={(e) => setCustomMessage(e.target.value)}
            rows={6}
            maxLength={10000}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="edit-scheduled-for">Send at</Label>
          <Input
            id="edit-scheduled-for"
            type="datetime-local"
            value={scheduledFor}
            min={minScheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={updateMutation.isPending}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={updateMutation.isPending}>
          {updateMutation.isPending ? "Saving…" : "Save Changes"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
