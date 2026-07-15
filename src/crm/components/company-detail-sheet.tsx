"use client";

/**
 * Company detail — the account, its people, and its deals.
 *
 * The "Needs review" banner is the fuzzy-duplicate flag. It is advisory: the server
 * created the row rather than blocking it, because "Cleveland Clinic Foundation"
 * might genuinely not be "Cleveland Clinic". Confirming it distinct is a one-click
 * dismissal; merging is a human job (and a deliberate v1 gap — see ROADMAP).
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Building2, ExternalLink, Loader2, Pencil, TriangleAlert } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useCrmCompany, useUpdateCompany, useSetCompanyArchived } from "@/crm/hooks/use-crm-api";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { CrmActivityTimeline } from "@/crm/components/crm-activity-timeline";
import { EditCompanyDialog } from "@/crm/components/edit-company-dialog";
import {
  DEAL_STATUS_COLORS,
  LIFECYCLE_COLORS,
  LIFECYCLE_LABELS,
  formatDealValue,
} from "@/crm/lib/crm-types";

export function CompanyDetailSheet({
  companyId,
  onOpenChange,
  canWrite,
}: {
  companyId: string | null;
  onOpenChange: (o: boolean) => void;
  canWrite: boolean;
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);
  const { data: company, isLoading } = useCrmCompany(companyId);
  const update = useUpdateCompany(companyId ?? "");
  const setArchived = useSetCompanyArchived(companyId ?? "");
  const [editOpen, setEditOpen] = useState(false);

  return (
    <Sheet open={!!companyId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {isLoading || !company ? (
          <div className="flex items-center gap-2 p-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-8">
                <Building2 className="h-5 w-5 text-muted-foreground" />
                {company.name}
              </SheetTitle>
              <SheetDescription asChild>
                <span className="flex flex-wrap items-center gap-2">
                  {company.industry && <Badge variant="outline">{company.industry}</Badge>}
                  {company.archivedAt && (
                    <Badge variant="outline" className="bg-rose-100 text-rose-700 border-rose-200">
                      Archived
                    </Badge>
                  )}
                  {[company.city, company.country].filter(Boolean).join(", ") || null}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-8">
              {(canWrite || canDelete) && (
                <div className="flex flex-wrap items-center gap-2">
                  {canWrite && (
                    <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                  {canDelete &&
                    (company.archivedAt ? (
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
                          if (!confirm("Archive this account? It will be hidden from the lists. Its deals are not affected. You can restore it from the archived view.")) return;
                          setArchived.mutate(true, { onSuccess: () => onOpenChange(false) });
                        }}
                      >
                        <Archive className="mr-2 h-3.5 w-3.5" />
                        Archive
                      </Button>
                    ))}
                </div>
              )}

              {company.needsReview && (
                <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div className="flex-1 text-sm">
                    <p className="font-medium text-amber-900">Possible duplicate</p>
                    <p className="mt-1 text-amber-800">
                      This name looks similar to an existing account. If they are genuinely
                      different organizations, dismiss this.
                    </p>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={async () => {
                          await update.mutateAsync({ needsReview: false });
                          toast.success("Marked as distinct");
                        }}
                        disabled={update.isPending}
                      >
                        They&apos;re different — dismiss
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {company.website && (
                <a
                  href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  {company.website}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}

              {company.notes && (
                <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
                  {company.notes}
                </p>
              )}

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Deals ({company.deals.length})</h3>
                {company.deals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No deals yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {company.deals.map((d) => {
                      const value = formatDealValue(d.dealValue, d.currency);
                      return (
                        <li
                          key={d.id}
                          className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium">{d.name}</p>
                            {d.event && (
                              <p className="text-xs text-muted-foreground">{d.event.name}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {/* Redacted for MEMBER — never render a fake 0. */}
                            <span className="font-medium">
                              {value ?? <span className="text-muted-foreground">—</span>}
                            </span>
                            <Badge variant="outline" className={DEAL_STATUS_COLORS[d.status]}>
                              {d.status}
                            </Badge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">People ({company.contacts.length})</h3>
                {company.contacts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No contacts linked yet. Link them from the contact&apos;s detail page.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {company.contacts.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {c.firstName} {c.lastName}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {c.jobTitle ? `${c.jobTitle} · ` : ""}
                            {c.email}
                          </p>
                        </div>
                        {c.lifecycleStage && (
                          <Badge
                            variant="outline"
                            className={LIFECYCLE_COLORS[c.lifecycleStage]}
                          >
                            {LIFECYCLE_LABELS[c.lifecycleStage]}
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <Separator />

              <CrmActivityTimeline entityType="COMPANY" entityId={company.id} />
            </div>

            <EditCompanyDialog company={company} open={editOpen} onOpenChange={setEditOpen} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
