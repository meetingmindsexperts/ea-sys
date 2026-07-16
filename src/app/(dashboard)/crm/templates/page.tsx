"use client";

/**
 * CRM → Templates — manage the org's reusable email templates.
 *
 * These pre-fill the "Start from a template" picker in the sponsor + deal email
 * dialogs. Org-wide shared; the built-in three are seeded on first load and are
 * themselves editable. Create/edit needs write access; archiving is admin + CRM_USER
 * (an ORGANIZER may edit but not archive — same as every CRM record).
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Archive, ArchiveRestore, FileText, Loader2, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCrmEmailTemplates, useSetCrmEmailTemplateArchived } from "@/crm/hooks/use-crm-api";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { canOwnDeals, canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmEmailTemplateDialog } from "@/crm/components/crm-email-template-dialog";
import type { CrmEmailTemplateRow } from "@/crm/lib/crm-types";

function preview(html: string): string {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

export default function CrmTemplatesPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);
  const canDelete = canDeleteCrm(session?.user?.role);

  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: templates = [], isLoading, isError, refetch } = useCrmEmailTemplates(showArchived);

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Reusable starting points for sponsor &amp; deal emails. Pick one when composing, then edit
          that send freely.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            onClick={() => setShowArchived((v) => !v)}
          >
            <Archive className="mr-2 h-3.5 w-3.5" />
            {showArchived ? "Showing archived" : "Show archived"}
          </Button>
          {canWrite && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New template
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading templates…
        </div>
      ) : isError ? (
        // An error must never render as "no templates" — M6.
        <CrmLoadError what="templates" onRetry={() => refetch()} />
      ) : templates.length === 0 ? (
        <CrmEmptyState
          icon={FileText}
          title={showArchived ? "No archived templates" : "No templates yet"}
          description={
            showArchived
              ? "Templates you archive show up here, ready to restore."
              : "Create a reusable email template your team can start from."
          }
          action={
            canWrite && !showArchived ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New template
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-3">
          {templates.map((t) => (
            <TemplateRow key={t.id} template={t} canWrite={canWrite} canDelete={canDelete} />
          ))}
        </ul>
      )}

      <CrmEmailTemplateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function TemplateRow({
  template,
  canWrite,
  canDelete,
}: {
  template: CrmEmailTemplateRow;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const setArchived = useSetCrmEmailTemplateArchived(template.id);
  const archived = !!template.archivedAt;

  return (
    <li className={cn("rounded-xl border bg-card p-4 transition-colors", archived && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate font-semibold">{template.name}</h3>
            {archived && (
              <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10px] text-rose-700">
                Archived
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            <span className="font-medium text-foreground/80">Subject:</span> {template.subject}
          </p>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{preview(template.body)}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canWrite && !archived && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Edit
            </Button>
          )}
          {canDelete &&
            (archived ? (
              <Button size="sm" variant="outline" disabled={setArchived.isPending} onClick={() => setArchived.mutate(false)}>
                <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                Restore
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                disabled={setArchived.isPending}
                onClick={() => {
                  if (!confirm("Archive this template? It will be hidden from the picker and this list. You can restore it from the archived view.")) return;
                  setArchived.mutate(true);
                }}
              >
                <Archive className="mr-2 h-3.5 w-3.5" />
                Archive
              </Button>
            ))}
        </div>
      </div>

      <CrmEmailTemplateDialog open={editOpen} onOpenChange={setEditOpen} template={template} />
    </li>
  );
}
