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
import { useSession } from "next-auth/react";
import { Link2, Loader2, Plus, Search, Users } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmCompanies, useCrmContacts } from "@/crm/hooks/use-crm-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { LIFECYCLE_COLORS, LIFECYCLE_LABELS, type CrmLifecycleStage } from "@/crm/lib/crm-types";

export default function CrmContactsPage() {
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const [q, setQ] = useState("");
  const [lifecycle, setLifecycle] = useState<string>("");
  const [companyId, setCompanyId] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);

  const { data: companies = [] } = useCrmCompanies();
  const { data: contacts = [], isLoading } = useCrmContacts({
    q: q || undefined,
    lifecycle: lifecycle || undefined,
    companyId: companyId || undefined,
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
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New contact
          </Button>
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
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading contacts…
        </div>
      ) : contacts.length === 0 ? (
        <div className="py-16 text-center">
          <Users className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {q ? "Nobody matches that search." : "No CRM contacts yet."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead className="text-right">Deals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id}>
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
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.company?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.jobTitle ?? "—"}</TableCell>
                  <TableCell>
                    {c.lifecycleStage ? (
                      <Badge variant="outline" className={LIFECYCLE_COLORS[c.lifecycleStage]}>
                        {LIFECYCLE_LABELS[c.lifecycleStage]}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{c._count?.deals ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateCrmContactDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
