"use client";
/**
 * The supplier list with the proposed-supplier queue (spec §6, §9 "supplier
 * list with the proposed-supplier queue"). A request-grant holder proposes;
 * the settle holder approves or rejects from the queue, edits, deactivates
 * and restores. The two classified fields (tax number, bank details) arrive
 * redacted for a reader outside the boundary and the row says so.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { canRequestProcurement, canSettleProcurement } from "@/lib/procurement-visibility";
import { BUDGET_CURRENCIES } from "@/procurement/lib/budget-schemas";
import { useDecideSupplier, useProposeSupplier, useSuppliers, useUpdateSupplier, type SupplierRow } from "@/procurement/hooks/use-procurement-api";
import { ErrorState, LoadingState, fmtWhen } from "@/procurement/components/budget-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Check, Loader2, Pencil, Plus, Truck, X } from "lucide-react";

type StatusFilter = "PROPOSED" | "APPROVED" | "REJECTED" | "ALL";
const STATUS_LABEL: Record<SupplierRow["approvalStatus"], string> = { PROPOSED: "Proposed", APPROVED: "Approved", REJECTED: "Rejected" };
const STATUS_CLASS: Record<SupplierRow["approvalStatus"], string> = {
  PROPOSED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  REJECTED: "bg-muted text-muted-foreground",
};

export default function SuppliersPage() {
  const { data: session } = useSession();
  const canSettle = canSettleProcurement(session?.user);
  const canPropose = canSettle || canRequestProcurement(session?.user);
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState("");
  const suppliers = useSuppliers({ status: status === "ALL" ? undefined : status, includeInactive: showInactive });
  const [proposing, setProposing] = useState(false);
  const [deciding, setDeciding] = useState<SupplierRow | null>(null);
  const [editing, setEditing] = useState<SupplierRow | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (suppliers.data ?? []).filter((s) => !q || s.code.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q) || s.legalName.toLowerCase().includes(q));
  }, [suppliers.data, search]);
  const proposed = (suppliers.data ?? []).filter((s) => s.approvalStatus === "PROPOSED").length;

  if (suppliers.isPending) return <LoadingState label="Loading suppliers…" />;
  if (suppliers.isError) return <ErrorState title="Couldn't load the suppliers" message={(suppliers.error as Error)?.message ?? ""} backHref="/procurement" backLabel="Budgets" />;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/procurement" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Budgets
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Truck className="h-6 w-6 text-primary" /> Suppliers</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {`${rows.length} shown${status === "ALL" && proposed > 0 ? ` · ${proposed} waiting for approval` : ""}. Only an approved supplier can carry a purchase order.`}
            </p>
          </div>
          {canPropose && (
            <Button onClick={() => setProposing(true)}><Plus className="h-4 w-4" /> {canSettle ? "Add supplier" : "Propose a supplier"}</Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1 space-y-1">
          <Label className="text-xs">Search</Label>
          <Input className="h-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" />
        </div>
        <div className="min-w-[12rem] space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="PROPOSED">Proposed</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} /> Show deactivated
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Code</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead className="w-36">Country · currency</TableHead>
              <TableHead className="w-40">Tax registration</TableHead>
              <TableHead className="w-32">Status</TableHead>
              {canSettle && <TableHead className="w-40 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={canSettle ? 6 : 5} className="py-8 text-center text-sm text-muted-foreground">No supplier matches.</TableCell></TableRow>
            ) : rows.map((s) => (
              <TableRow key={s.id} className={s.isActive ? undefined : "opacity-60"}>
                <TableCell className="font-mono text-xs">{s.code}</TableCell>
                <TableCell>
                  <div>{s.displayName}</div>
                  {s.legalName !== s.displayName && <div className="text-xs text-muted-foreground">{s.legalName}</div>}
                  {s.riskStatus !== "NONE" && <span className="mt-1 inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800 dark:bg-red-950 dark:text-red-300">{s.riskStatus === "WATCH" ? "On watch" : "Blocked"}</span>}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{[s.country, s.currency].filter(Boolean).join(" · ")}</TableCell>
                <TableCell className="text-sm">{s.financialsRedacted ? <span className="text-muted-foreground" title="Visible to the settle holder and admins">redacted</span> : (s.taxRegistrationNo ?? <span className="text-muted-foreground">not set</span>)}</TableCell>
                <TableCell>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[s.approvalStatus]}`}>{STATUS_LABEL[s.approvalStatus]}</span>
                  {!s.isActive && <span className="ml-1 text-xs text-muted-foreground">deactivated</span>}
                </TableCell>
                {canSettle && (
                  <TableCell className="text-right">
                    {s.approvalStatus === "PROPOSED" && (
                      <Button variant="outline" size="sm" className="mr-1" onClick={() => setDeciding(s)}><Check className="h-4 w-4" /> Decide</Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${s.code}`} onClick={() => setEditing(s)}><Pencil className="h-4 w-4" /></Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canPropose && <ProposeDialog open={proposing} onOpenChange={setProposing} settle={canSettle} />}
      {canSettle && deciding && <DecideDialog key={deciding.id} supplier={deciding} onClose={() => setDeciding(null)} />}
      {canSettle && editing && <EditDialog key={`${editing.id}-${editing.version}`} supplier={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const list = BUDGET_CURRENCIES.includes(value as (typeof BUDGET_CURRENCIES)[number]) ? [...BUDGET_CURRENCIES] : [value, ...BUDGET_CURRENCIES];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>{list.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function ProposeDialog({ open, onOpenChange, settle }: { open: boolean; onOpenChange: (o: boolean) => void; settle: boolean }) {
  const propose = useProposeSupplier();
  const empty = { legalName: "", displayName: "", code: "", country: "", currency: "AED", taxRegistrationNo: "", paymentTerms: "", contactName: "", contactEmail: "", contactPhone: "", notes: "" };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    if (!f.legalName.trim()) return toast.error("A supplier needs its legal name.");
    if (f.contactEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contactEmail.trim())) return toast.error("The contact email does not look like an email address.");
    try {
      const s = await propose.mutateAsync({
        legalName: f.legalName.trim(),
        displayName: f.displayName.trim() || undefined,
        code: f.code.trim() || undefined,
        country: f.country.trim() || null,
        currency: f.currency,
        taxRegistrationNo: f.taxRegistrationNo.trim() || null,
        paymentTerms: f.paymentTerms.trim() || null,
        contacts: f.contactName.trim() ? [{ name: f.contactName.trim(), ...(f.contactEmail.trim() ? { email: f.contactEmail.trim() } : {}), ...(f.contactPhone.trim() ? { phone: f.contactPhone.trim() } : {}) }] : [],
        notes: f.notes.trim() || null,
      });
      toast.success(settle ? `${s.code} added and approved.` : `${s.code} proposed; it waits for the settle holder's approval.`);
      setF(empty);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{settle ? "Add a supplier" : "Propose a supplier"}</DialogTitle>
          <DialogDescription>{settle ? "Created approved: you hold the settle grant." : "The settle holder checks the tax number, the terms and the currency before the supplier can carry an order."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="legalName">Legal name</Label><Input id="legalName" value={f.legalName} onChange={(e) => set("legalName", e.target.value)} placeholder="As on the trade licence" autoFocus /></div>
          <div className="space-y-1"><Label htmlFor="displayName">Display name</Label><Input id="displayName" value={f.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Short name (optional)" /></div>
          <div className="space-y-1"><Label htmlFor="code">Code</Label><Input id="code" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="Derived from the name if empty" /></div>
          <div className="space-y-1"><Label htmlFor="country">Country</Label><Input id="country" value={f.country} onChange={(e) => set("country", e.target.value)} placeholder="United Arab Emirates" /></div>
          <div className="space-y-1"><Label>Currency</Label><CurrencySelect value={f.currency} onChange={(v) => set("currency", v)} /></div>
          <div className="space-y-1"><Label htmlFor="trn">Tax registration number</Label><Input id="trn" value={f.taxRegistrationNo} onChange={(e) => set("taxRegistrationNo", e.target.value)} placeholder="If known" /></div>
          <div className="space-y-1"><Label htmlFor="terms">Payment terms</Label><Input id="terms" value={f.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} placeholder="30 days from invoice" /></div>
          <div className="space-y-1"><Label htmlFor="cname">Contact name</Label><Input id="cname" value={f.contactName} onChange={(e) => set("contactName", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="cemail">Contact email</Label><Input id="cemail" type="email" value={f.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="cphone">Contact phone</Label><Input id="cphone" value={f.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="snotes">Notes</Label><Textarea id="snotes" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Why this supplier, what they are for" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={propose.isPending}>Cancel</Button>
          <Button onClick={() => void save()} disabled={propose.isPending}>{propose.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {settle ? "Add supplier" : "Propose"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecideDialog({ supplier, onClose }: { supplier: SupplierRow; onClose: () => void }) {
  const decide = useDecideSupplier();
  const [note, setNote] = useState("");
  async function run(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && !note.trim()) return toast.error("Say why the supplier is rejected; the requester reads it.");
    try {
      await decide.mutateAsync({ supplierId: supplier.id, decision, note: note.trim() || null });
      toast.success(decision === "APPROVED" ? `${supplier.code} approved; it can now carry an order.` : `${supplier.code} rejected.`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !decide.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Decide on ${supplier.displayName}`}</DialogTitle>
          <DialogDescription>Check the tax registration number, the payment terms and the currency. Approval lets a purchase order carry this supplier; the decision is taken once.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Legal name</dt><dd>{supplier.legalName}</dd>
          <dt className="text-muted-foreground">Tax registration</dt><dd>{supplier.taxRegistrationNo ?? <span className="text-muted-foreground">not given</span>}</dd>
          <dt className="text-muted-foreground">Currency</dt><dd>{supplier.currency}</dd>
          <dt className="text-muted-foreground">Payment terms</dt><dd>{supplier.paymentTerms ?? <span className="text-muted-foreground">not given</span>}</dd>
          <dt className="text-muted-foreground">Proposed</dt><dd>{fmtWhen(supplier.createdAt)}</dd>
        </dl>
        <div className="space-y-1">
          <Label htmlFor="dnote">Note for the requester</Label>
          <Textarea id="dnote" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Required on a rejection" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={decide.isPending}>Cancel</Button>
          <Button variant="outline" className="text-destructive" onClick={() => void run("REJECTED")} disabled={decide.isPending}><X className="h-4 w-4" /> Reject</Button>
          <Button onClick={() => void run("APPROVED")} disabled={decide.isPending}>{decide.isPending && <Loader2 className="h-4 w-4 animate-spin" />}<Check className="h-4 w-4" /> Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ supplier, onClose }: { supplier: SupplierRow; onClose: () => void }) {
  const update = useUpdateSupplier();
  const [f, setF] = useState({
    legalName: supplier.legalName, displayName: supplier.displayName, country: supplier.country ?? "", currency: supplier.currency,
    taxRegistrationNo: supplier.taxRegistrationNo ?? "", paymentTerms: supplier.paymentTerms ?? "", riskStatus: supplier.riskStatus, isActive: supplier.isActive, notes: supplier.notes ?? "",
    bankName: supplier.bankDetails?.bankName ?? "", accountName: supplier.bankDetails?.accountName ?? "", iban: supplier.bankDetails?.iban ?? "", swift: supplier.bankDetails?.swift ?? "", accountNumber: supplier.bankDetails?.accountNumber ?? "",
  });
  const set = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    if (!f.legalName.trim()) return toast.error("A supplier needs its legal name.");
    const bank = { bankName: f.bankName.trim(), accountName: f.accountName.trim(), iban: f.iban.trim(), swift: f.swift.trim(), accountNumber: f.accountNumber.trim() };
    const bankDetails = Object.values(bank).some(Boolean) ? Object.fromEntries(Object.entries(bank).filter(([, v]) => v)) : null;
    // Send only what changed: the audit row lists the fields a save touched, so an untouched
    // field must not appear there. `changed` compares each candidate with the loaded row.
    const next = {
      legalName: f.legalName.trim(),
      displayName: f.displayName.trim() || f.legalName.trim(),
      country: f.country.trim() || null,
      currency: f.currency,
      taxRegistrationNo: f.taxRegistrationNo.trim() || null,
      paymentTerms: f.paymentTerms.trim() || null,
      bankDetails,
      riskStatus: f.riskStatus,
      isActive: f.isActive,
      notes: f.notes.trim() || null,
    };
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(v, supplier[k as keyof typeof next])));
    if (Object.keys(changed).length === 0) {
      toast.message("Nothing changed.");
      return onClose();
    }
    try {
      await update.mutateAsync({ supplierId: supplier.id, expectedVersion: supplier.version, ...changed });
      toast.success(`${supplier.code} saved.`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{`Edit ${supplier.code}`}</DialogTitle>
          <DialogDescription>Bank details and the tax number are seen by the settle holder and admins only, and never written to the activity trail.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="elegal">Legal name</Label><Input id="elegal" value={f.legalName} onChange={(e) => set("legalName", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="edisplay">Display name</Label><Input id="edisplay" value={f.displayName} onChange={(e) => set("displayName", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ecountry">Country</Label><Input id="ecountry" value={f.country} onChange={(e) => set("country", e.target.value)} /></div>
          <div className="space-y-1"><Label>Currency</Label><CurrencySelect value={f.currency} onChange={(v) => set("currency", v)} /></div>
          <div className="space-y-1"><Label htmlFor="etrn">Tax registration number</Label><Input id="etrn" value={f.taxRegistrationNo} onChange={(e) => set("taxRegistrationNo", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="eterms">Payment terms</Label><Input id="eterms" value={f.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} /></div>
          <div className="space-y-1">
            <Label>Risk</Label>
            <Select value={f.riskStatus} onValueChange={(v) => set("riskStatus", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="NONE">None</SelectItem><SelectItem value="WATCH">On watch</SelectItem><SelectItem value="BLOCKED">Blocked</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label htmlFor="ebank">Bank name</Label><Input id="ebank" value={f.bankName} onChange={(e) => set("bankName", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="eacct">Account name</Label><Input id="eacct" value={f.accountName} onChange={(e) => set("accountName", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="eiban">IBAN</Label><Input id="eiban" value={f.iban} onChange={(e) => set("iban", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="eswift">SWIFT / BIC</Label><Input id="eswift" value={f.swift} onChange={(e) => set("swift", e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="eaccno">Account number</Label><Input id="eaccno" value={f.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="enotes">Notes</Label><Textarea id="enotes" rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={f.isActive} onCheckedChange={(v) => set("isActive", v)} /> Active (a deactivated supplier cannot carry a new order; its history stays)</label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button onClick={() => void save()} disabled={update.isPending}>{update.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
