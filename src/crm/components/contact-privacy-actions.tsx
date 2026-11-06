"use client";

/**
 * A CRM contact's data on request (crm-privacy-service.ts): "Export data"
 * downloads everything held on them (crm.export), "Erase" removes them and
 * their correspondence for good (crm.purge, SUPER_ADMIN). Erasure needs the
 * contact's email address typed exactly, and says afterwards what it removed
 * and what it left for review.
 */
import { useState } from "react";
import { Download, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEraseCrmContact } from "@/crm/hooks/use-crm-api";

export function ContactPrivacyActions({
  crmContactId,
  email,
  name,
  onErased,
}: {
  crmContactId: string;
  email: string;
  name: string;
  onErased?: () => void;
}) {
  const canExport = useCan("crm.export") === "allowed";
  const canErase = useCan("crm.purge") === "allowed";
  const erase = useEraseCrmContact(crmContactId);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  if (!canExport && !canErase) return null;

  return (
    <>
      {canExport && (
        <Button size="sm" variant="outline" asChild>
          <a href={`/api/crm/contacts/${crmContactId}/export`} download>
            <Download className="mr-2 h-3.5 w-3.5" />
            Export data
          </a>
        </Button>
      )}
      {canErase && (
        <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
          <ShieldX className="mr-2 h-3.5 w-3.5" />
          Erase
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setTyped(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Erase {name}?</DialogTitle>
            <DialogDescription>
              For a data erasure request. This removes the contact, every email thread with them and their messages on
              other threads (with attachment files), their notes, tasks, History and notifications, and their place on
              deals. Deals, accounts and quotes stay, and so does any event contact record of theirs. Raw email copies
              in the mail bucket expire after 90 days. It cannot be undone: export their data first if they asked for
              a copy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="erase-confirm-email">Type their email address to confirm</Label>
            <Input id="erase-confirm-email" name="confirmEmail" autoComplete="off" placeholder={email} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={erase.isPending || typed.trim().toLowerCase() !== email.trim().toLowerCase()}
              onClick={() =>
                erase.mutate(typed, {
                  onSuccess: (r) => {
                    toast.success(
                      `Erased: ${r.erased.emailThreads} email thread(s), ${r.erased.emailMessages} message(s), ${r.erased.notes} note(s), ${r.erased.tasks} task(s), ${r.erased.historyLines + r.erased.historyMentions} History line(s).` +
                        (r.remaining.quotesNamingThem ? ` ${r.remaining.quotesNamingThem} sent quote(s) are addressed to them by name and were kept: review them.` : ""),
                      { duration: 10000 },
                    );
                    setOpen(false);
                    onErased?.();
                  },
                })
              }
            >
              Erase permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
