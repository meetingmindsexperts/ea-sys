"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ChangeEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentEmail: string;
  /**
   * The PATCH endpoint that performs the email-change cascade. The
   * route must accept `{ newEmail }` and return either a success body
   * or `{ error, code }` on 4xx. Examples:
   *   /api/events/{eventId}/speakers/{speakerId}/email
   *   /api/events/{eventId}/registrations/{registrationId}/email
   *   /api/contacts/{contactId}/email
   */
  endpoint: string;
  entityLabel: string;
  onSuccess?: () => void;
}

export function ChangeEmailDialog({
  open,
  onOpenChange,
  currentEmail,
  endpoint,
  entityLabel,
  onSuccess,
}: ChangeEmailDialogProps) {
  const [newEmail, setNewEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setNewEmail("");
    setConfirm("");
    setSaving(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) {
      toast.error("New email is required");
      return;
    }
    if (trimmed === currentEmail.trim().toLowerCase()) {
      toast.error("New email must be different from the current email");
      return;
    }
    if (trimmed !== confirm.trim().toLowerCase()) {
      toast.error("Emails do not match");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: trimmed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Failed to change email");
        setSaving(false);
        return;
      }

      const parts: string[] = [`Email updated to ${trimmed}`];
      if (json.userCascaded) parts.push("Login email updated.");
      if (json.contactAction === "updated") parts.push("Contact record re-pointed.");
      if (json.contactAction === "merged") parts.push("Merged into existing contact at that email.");
      toast.success(parts.join(" "));

      reset();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change email");
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            Update the canonical email for this {entityLabel}.{" "}
            {entityLabel === "contact"
              ? "This updates the contact record only — it does not change any linked speaker, registrant, or login account. Use the speaker or registration screen to change those."
              : "This cascades to the login account (if any) and the organization contact record."}{" "}
            Current: <span className="font-medium">{currentEmail}</span>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-email">New email</Label>
            <Input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="new@example.com"
              autoComplete="off"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-email">Confirm new email</Label>
            <Input
              id="confirm-email"
              type="email"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="new@example.com"
              autoComplete="off"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Change email"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
