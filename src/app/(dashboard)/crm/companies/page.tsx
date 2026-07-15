"use client";

/**
 * Companies — first-class Accounts.
 *
 * `Contact.organization` is a free-text string today, which is why "Cleveland
 * Clinic" and "Cleveland Clinic Foundation" are two different things in the CRM's
 * eyes. This page is where that gets curated.
 *
 * The "Needs review" badge is the fuzzy-duplicate flag: the server creates a
 * near-match rather than blocking it (they might genuinely be different entities)
 * and flags it for a human. Filtering to those is the merge worklist.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Archive, Building2, Plus, Search, TriangleAlert } from "lucide-react";
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
import { CompanyDetailSheet } from "@/crm/components/company-detail-sheet";
import { CreateCompanyDialog } from "@/crm/components/create-company-dialog";
import { CrmEmptyState } from "@/crm/components/crm-empty-state";
import { CrmTableSkeleton } from "@/crm/components/crm-skeletons";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmCompanies } from "@/crm/hooks/use-crm-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";

export default function CrmCompaniesPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const [q, setQ] = useState("");
  const [industry, setIndustry] = useState<string>("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Unfiltered list drives BOTH the option dropdown (a stable industry list) and
  // the review count — deriving the options from the filtered set would make them
  // vanish as you use them.
  const { data: allCompanies = [] } = useCrmCompanies();
  const { data: companies = [], isLoading } = useCrmCompanies({
    q: q || undefined,
    industry: industry || undefined,
    archived: showArchived ? "1" : undefined,
  });
  const rows = onlyReview ? companies.filter((c) => c.needsReview) : companies;
  const reviewCount = allCompanies.filter((c) => c.needsReview).length;
  const industries = Array.from(
    new Set(allCompanies.map((c) => c.industry).filter((i): i is string => !!i)),
  ).sort();

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Sponsors, exhibitors, hospitals and societies
        </p>
        {canWrite && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New company
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search companies…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {industries.length > 0 && (
          <Select value={industry || "__all__"} onValueChange={(v) => setIndustry(v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-[12rem]">
              <SelectValue placeholder="Any industry" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Any industry</SelectItem>
              {industries.map((i) => (
                <SelectItem key={i} value={i}>
                  {i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {reviewCount > 0 && (
          <Button
            variant={onlyReview ? "default" : "outline"}
            size="sm"
            onClick={() => setOnlyReview((v) => !v)}
          >
            <TriangleAlert className="mr-2 h-4 w-4" />
            Needs review ({reviewCount})
          </Button>
        )}
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive className="mr-2 h-4 w-4" />
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
      </div>

      {isLoading ? (
        <CrmTableSkeleton rows={6} cols={5} />
      ) : rows.length === 0 ? (
        <CrmEmptyState
          icon={Building2}
          title={
            showArchived
              ? "No archived companies"
              : q
                ? "No companies match that search"
                : "No companies yet"
          }
          description={
            showArchived
              ? "Accounts you archive will show up here, ready to restore."
              : q
                ? "Try a different search term."
                : "Sponsors, exhibitors, hospitals and societies — the accounts you sell to."
          }
          action={
            canWrite && !showArchived && !q ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New company
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
                <TableHead>Industry</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Contacts</TableHead>
                <TableHead className="text-right">Deals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.id}
                  className={cn("cursor-pointer transition-colors", c.archivedAt && "opacity-60")}
                  onClick={() => setOpenId(c.id)}
                >
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      {c.name}
                      {c.needsReview && (
                        <Badge
                          variant="outline"
                          className="border-amber-200 bg-amber-50 text-[10px] text-amber-700"
                        >
                          Needs review
                        </Badge>
                      )}
                      {c.archivedAt && (
                        <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10px] text-rose-700">
                          Archived
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.industry ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {[c.city, c.country].filter(Boolean).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c._count?.contacts ?? 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{c._count?.deals ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CompanyDetailSheet
        companyId={openId}
        onOpenChange={(o) => !o && setOpenId(null)}
        canWrite={canWrite}
      />
    </div>
  );
}
