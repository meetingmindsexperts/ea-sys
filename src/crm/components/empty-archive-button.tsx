"use client";

/**
 * "Empty archive" — the SUPER_ADMIN-only bulk purge of every archived record of
 * one kind (owner request, July 20 2026). Shown in the deals / companies /
 * contacts list toolbars, but ONLY while the archived view is active and only to
 * a SUPER_ADMIN.
 *
 * The server does deals→companies→contacts ordering + per-record refusal
 * reporting; this surfaces the summary (and any skips — e.g. a company still
 * referenced by an active deal) rather than pretending it all went.
 */
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canPurgeCrm } from "@/crm/lib/crm-roles";
import { usePurgeArchived } from "@/crm/hooks/use-crm-api";

const LABEL: Record<"deals" | "companies" | "contacts", { noun: string; confirm: string }> = {
  deals: {
    noun: "archived deals",
    confirm: "Permanently delete EVERY archived deal — with all their people links, line items, notes and tasks. This cannot be undone.",
  },
  companies: {
    noun: "archived companies",
    confirm: "Permanently delete every archived account (those still referenced by a deal are skipped). This cannot be undone.",
  },
  contacts: {
    noun: "archived contacts",
    confirm: "Permanently delete every archived contact — removing them from any deals they were on. This cannot be undone.",
  },
};

export function EmptyArchiveButton({
  entity,
  visible,
}: {
  entity: "deals" | "companies" | "contacts";
  /** Only meaningful in the archived view — the caller passes showArchived. */
  visible: boolean;
}) {
  const { data: session } = useSession();
  const purge = usePurgeArchived();

  if (!canPurgeCrm(session?.user?.role) || !visible) return null;

  const { noun, confirm: confirmCopy } = LABEL[entity];

  return (
    <Button
      variant="destructive"
      size="sm"
      disabled={purge.isPending}
      onClick={() => {
        if (!confirm(confirmCopy)) return;
        purge.mutate(entity, {
          onSuccess: (res) => {
            const n = res.purged[entity];
            const skipped = res.skipped.length;
            if (n === 0 && skipped === 0) {
              toast.info(`No ${noun} to delete`);
              return;
            }
            let msg = `Permanently deleted ${n} ${noun}`;
            if (skipped > 0) msg += ` — ${skipped} skipped (${res.skipped[0]?.reason ?? "still in use"})`;
            if (res.capped) msg += " — more remain, run again";
            toast.success(msg);
          },
        });
      }}
    >
      <Trash2 className="mr-2 h-4 w-4" />
      Empty archive
    </Button>
  );
}
