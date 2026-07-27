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
 *
 * Filters + sort live in the URL (useCrmFilters), same as the board/reports/tasks,
 * so a filtered, sorted book is shareable, bookmarkable and survives refresh/back.
 */
import Link from "next/link";
import { Suspense, useState } from "react";
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
import { SortableTh, nextSort, type SortDir } from "@/crm/components/sortable-th";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmCompanies, useCrmContacts } from "@/crm/hooks/use-crm-api";
import { CrmLoadError } from "@/crm/components/crm-load-error";
import { EmptyArchiveButton } from "@/crm/components/empty-archive-button";
import { useCrmFilters } from "@/crm/lib/use-crm-filters";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { cn } from "@/lib/utils";
import {
  CONTACT_STATUS_COLORS,
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_VALUES,
  LIFECYCLE_COLORS,
  LIFECYCLE_LABELS,
  type CrmContactRow,
  type CrmLifecycleStage,
} from "@/crm/lib/crm-types";
import { contactScoreColor } from "@/crm/lib/contact-score";

function ContactsInner() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const { get, set } = useCrmFilters();
  const q = get("q");
  const lifecycle = get("lifecycle");
  const status = get("status");
  const owner = get("owner");
  const companyId = get("company");
  const showArchived = !!get("archived");
  const sortKey = get("sort");
  const dir = (get("dir") || "asc") as SortDir;

  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
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
  const rows = sortKey ? [...contacts].sort(makeComparator(sortKey, dir)) : contacts;
  const onSort = (key: string) => set(nextSort(sortKey, dir, key));

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
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>

        {/* "All contacts" ↔ "My contacts" ↔ a specific rep's book. */}
        <OwnerFilter
          value={owner}
          onChange={(userId) => set({ owner: userId ?? null })}
          placeholder="All contacts"
          meId={session?.user?.id}
          meLabel="My contacts"
        />

        <Select value={status || "__all__"} onValueChange={(v) => set({ status: v === "__all__" ? null : v })}>
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

        <Select value={lifecycle || "__all__"} onValueChange={(v) => set({ lifecycle: v === "__all__" ? null : v })}>
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

        <Select value={companyId || "__all__"} onValueChange={(v) => set({ company: v === "__all__" ? null : v })}>
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
          onClick={() => set({ archived: showArchived ? null : "1" })}
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
      ) : rows.length === 0 ? (
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
                <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={dir} onSort={onSort} />
                <TableHead>Company</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Owner</TableHead>
                <SortableTh label="Score" sortKey="score" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
                <SortableTh label="Deals" sortKey="deals" activeKey={sortKey} dir={dir} onSort={onSort} align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
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

/** Client-side comparator for the sortable columns (all unambiguous — no money). */
function makeComparator(key: string, dir: SortDir) {
  const mult = dir === "asc" ? 1 : -1;
  return (a: CrmContactRow, b: CrmContactRow) => {
    let cmp = 0;
    if (key === "name") {
      cmp = `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
    } else if (key === "score") {
      cmp = (a.score ?? 0) - (b.score ?? 0);
    } else if (key === "deals") {
      cmp = (a._count?.deals ?? 0) - (b._count?.deals ?? 0);
    }
    return cmp * mult;
  };
}

export default function CrmContactsPage() {
  // useCrmFilters reads useSearchParams — needs a Suspense boundary.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ContactsInner />
    </Suspense>
  );
}
