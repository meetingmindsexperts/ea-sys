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
import { Building2, Loader2, Plus, Search, TriangleAlert } from "lucide-react";
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
import { useCrmCompanies } from "@/crm/hooks/use-crm-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";

export default function CrmCompaniesPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const [q, setQ] = useState("");
  const [onlyReview, setOnlyReview] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: companies = [], isLoading } = useCrmCompanies(q || undefined);
  const rows = onlyReview ? companies.filter((c) => c.needsReview) : companies;
  const reviewCount = companies.filter((c) => c.needsReview).length;

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
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search companies…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
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
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading companies…
        </div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center">
          <Building2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {q ? "No companies match that search." : "No companies yet."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
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
                  className="cursor-pointer"
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
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.industry ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {[c.city, c.country].filter(Boolean).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right">{c._count?.contacts ?? 0}</TableCell>
                  <TableCell className="text-right">{c._count?.deals ?? 0}</TableCell>
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
