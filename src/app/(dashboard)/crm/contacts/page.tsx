"use client";

/**
 * CRM Contacts — the people we NEGOTIATE WITH.
 *
 * Pharma reps, exhibitor sales managers, society liaisons, procurement. This is a
 * DIFFERENT POPULATION from the event contact store (/contacts), which holds HCPs —
 * doctors, nurses, allied health — and is mirrored to the external HCP marketing
 * list. A rep must never land there, so they live in their own table.
 *
 * A person who is genuinely both (a rep who also attends the conference) is LINKED
 * to their event contact record, not duplicated — one human, one record, two hats.
 */
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Archive, Link2, Plus, Search, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CreateCrmContactDialog } from "@/crm/components/create-crm-contact-dialog";
import { OwnerFilter } from "@/crm/components/filters/owner-filter";
import { FreshsalesImportDialog } from "@/crm/components/freshsales-import-dialog";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmTableSkeleton } from "@/crm/components/crm-skeletons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmCompanies, useCrmContacts } from "@/crm/hooks/use-crm-api";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { EmptyArchiveButton } from "@/crm/components/empty-archive-button";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { cn } from "@/lib/utils";
import {
  CONTACT_STATUS_COLORS,
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_VALUES,
  LIFECYCLE_COLORS,
  LIFECYCLE_LABELS,
  type CrmLifecycleStage,
} from "@/crm/lib/crm-types";
import { contactScoreColor } from "@/crm/lib/contact-score";

export default function CrmContactsPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const [q, setQ] = useState("");
  const [lifecycle, setLifecycle] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [owner, setOwner] = useState<string>("");
  const [companyId, setCompanyId] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const router = useRouter();

  const { data: companies = [] } = useCrmCompanies();
  const { data: contacts = [], isLoading, isError, refetch } = useCrmContacts({
    q: q || undefined,
    lifecycle: lifecycle || undefined,
    status: status || undefined,
    owner: owner || undefined,
    companyId: companyId || undefined,
    archived: showArchived ? "1" : undefined,
  });

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Reps, exhibitor sales and procurement — the people we deal with.
          <br />
          <span className="text-xs">
            Doctors and other HCPs live in the event{" "}
            <Link href="/contacts" className="underline">
              Contacts
            </Link>{" "}
            store, not here.
          </span>
        </p>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Import CSV
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New contact
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {/* "All contacts" ↔ "My contacts" ↔ a specific rep's book. */}
        <OwnerFilter
          value={owner}
          onChange={(userId) => setOwner(userId ?? "")}
          placeholder="All contacts"
          meId={session?.user?.id}
          meLabel="My contacts"
        />

        <Select value={status || "__all__"} onValueChange={(v) => setStatus(v === "__all__" ? "" : v)}>
          <SelectTrigger className="w-[10rem]">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any status</SelectItem>
            {CONTACT_STATUS_VALUES.map((s) => (
              <SelectItem key={s} value={s}>
                {CONTACT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={lifecycle || "__all__"} onValueChange={(v) => setLifecycle(v === "__all__" ? "" : v)}>
          <SelectTrigger className="w-[11rem]">
            <SelectValue placeholder="Any lifecycle" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any lifecycle</SelectItem>
            {(Object.keys(LIFECYCLE_LABELS) as CrmLifecycleStage[]).map((s) => (
              <SelectItem key={s} value={s}>
                {LIFECYCLE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={companyId || "__all__"} onValueChange={(v) => setCompanyId(v === "__all__" ? "" : v)}>
          <SelectTrigger className="w-[13rem]">
            <SelectValue placeholder="Any company" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any company</SelectItem>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive className="mr-2 h-3.5 w-3.5" />
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
        <EmptyArchiveButton entity="contacts" visible={showArchived} />
      </div>

      {isLoading ? (
        <CrmTableSkeleton rows={6} cols={8} />
      ) : isError ? (
        <CrmLoadError what="contacts" onRetry={() => refetch()} />
      ) : contacts.length === 0 ? (
        <CrmEmptyState
          icon={Users}
          title={
            showArchived
              ? "No archived contacts"
              : q
                ? "Nobody matches that search"
                : "No CRM contacts yet"
          }
          description={
            showArchived
              ? "Contacts you archive will show up here, ready to restore."
              : q
                ? "Try a different name or email."
                : "Reps, exhibitor sales and procurement — the people you deal with."
          }
          action={
            canWrite && !showArchived && !q ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New contact
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Deals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow
                  key={c.id}
                  className={cn("cursor-pointer transition-colors hover:bg-muted/40", c.archivedAt && "opacity-60")}
                  onClick={() => router.push(`/crm/contacts/${c.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div>
                        <p className="font-medium">
                          {c.firstName} {c.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground">{c.email}</p>
                      </div>
                      {/* This rep is ALSO in the event contact store — i.e. they attend. */}
                      {c.contactId && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Also in the event contact store — they attend as well
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {c.archivedAt && (
                        <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10px] text-rose-700">
                          Archived
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.company?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.jobTitle ?? "—"}</TableCell>
                  <TableCell>
                    {c.status ? (
                      <Badge variant="outline" className={CONTACT_STATUS_COLORS[c.status]}>
                        {CONTACT_STATUS_LABELS[c.status]}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {c.lifecycleStage ? (
                      <Badge variant="outline" className={LIFECYCLE_COLORS[c.lifecycleStage]}>
                        {LIFECYCLE_LABELS[c.lifecycleStage]}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.owner ? `${c.owner.firstName} ${c.owner.lastName}` : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className={cn("tabular-nums", contactScoreColor(c.score ?? 0))}>
                      {c.score ?? 0}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c._count?.deals ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateCrmContactDialog open={createOpen} onOpenChange={setCreateOpen} />

      {importOpen && <FreshsalesImportDialog type="contacts" open={importOpen} onOpenChange={setImportOpen} />}
    </div>
  );
}
