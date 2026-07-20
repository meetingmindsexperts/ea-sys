"use client";

/**
 * "Delete permanently" — the SUPER_ADMIN-only hard delete of ONE archived CRM
 * record (owner request, July 20 2026). Shared by the deal / company / contact
 * record pages so the gate check + confirm copy live in ONE place.
 *
 * Renders nothing unless the viewer is a SUPER_ADMIN AND the record is archived
 * (purge is archived-only — the server enforces both, this is UX). The button
 * is deliberately destructive-styled and behind a typed confirm.
 */
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canPurgeCrm } from "@/crm/lib/crm-roles";
import { usePurgeCrmRecord } from "@/crm/hooks/use-crm-api";

const CASCADE_COPY: Record<"deal" | "company" | "contact", string> = {
  deal: "This permanently deletes the deal and everything on it — its people links, line items, notes and follow-up tasks. This cannot be undone.",
  company: "This permanently deletes the account, its notes and tasks. It is refused while any deal still references it. This cannot be undone.",
  contact: "This permanently deletes the contact — they are removed from every deal they were on, along with their notes and tasks. This cannot be undone.",
};

export function PurgeRecordButton({
  entity,
  id,
  name,
  archived,
  onPurged,
}: {
  entity: "deal" | "company" | "contact";
  id: string;
  name: string;
  archived: boolean;
  /** Navigate away after a successful purge — the record no longer exists. */
  onPurged?: () => void;
}) {
  const { data: session } = useSession();
  const purge = usePurgeCrmRecord();

  // Purge is SUPER_ADMIN + archived-only. Hide otherwise — the server refuses it
  // regardless, this just doesn't dangle a button nobody can use.
  if (!canPurgeCrm(session?.user?.role) || !archived) return null;

  return (
    <Button
      size="sm"
      variant="destructive"
      disabled={purge.isPending}
      onClick={() => {
        if (!confirm(`${CASCADE_COPY[entity]}\n\nType is not required, but be sure: delete "${name}" forever?`)) return;
        purge.mutate(
          { entity, id },
          {
            onSuccess: () => {
              toast.success("Permanently deleted");
              onPurged?.();
            },
          },
        );
      }}
    >
      <Trash2 className="mr-2 h-3.5 w-3.5" />
      Delete permanently
    </Button>
  );
}
