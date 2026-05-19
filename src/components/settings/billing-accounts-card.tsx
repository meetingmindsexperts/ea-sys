"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Building2, Plus, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBillingAccounts, useCreateBillingAccount, useUpdateBillingAccount,
  queryKeys,
} from "@/hooks/use-api";

type Payer = {
  id: string;
  name: string;
  type: "INSTITUTION" | "COMPANY" | "OTHER";
  email: string | null;
  phone: string | null;
  contactName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
  needsReview: boolean;
  _count?: { registrations: number };
};

const EMPTY = {
  name: "", type: "INSTITUTION" as Payer["type"], email: "", phone: "",
  contactName: "", address: "", city: "", state: "", zipCode: "",
  country: "", taxNumber: "", notes: "",
};

export function BillingAccountsCard() {
  const { data: accounts = [], isLoading } = useBillingAccounts({ includeInactive: "1" });
  const create = useCreateBillingAccount();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Payer | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  const update = useUpdateBillingAccount(editing?.id ?? "");
  const queryClient = useQueryClient();
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY });
    setOpen(true);
  };
  const openEdit = (p: Payer) => {
    setEditing(p);
    setForm({
      name: p.name, type: p.type, email: p.email ?? "", phone: p.phone ?? "",
      contactName: p.contactName ?? "", address: p.address ?? "", city: p.city ?? "",
      state: p.state ?? "", zipCode: p.zipCode ?? "", country: p.country ?? "",
      taxNumber: p.taxNumber ?? "", notes: p.notes ?? "",
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      if (editing) {
        await update.mutateAsync({ ...form, needsReview: false });
        toast.success("Billing account updated");
      } else {
        await create.mutateAsync(form);
        toast.success("Billing account created");
      }
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save billing account");
    }
  };

  const toggleActive = async (p: Payer) => {
    setTogglingId(p.id);
    try {
      const res = await fetch(`/api/billing-accounts/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Request failed");
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.billingAccounts });
      toast.success(p.isActive ? "Deactivated" : "Reactivated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update status");
    } finally {
      setTogglingId(null);
    }
  };

  const saving = create.isPending || update.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              Billing Accounts
            </CardTitle>
            <CardDescription>
              Reusable third-party payers for &quot;charge to another account&quot; —
              a doctor&apos;s hospital, or a company/grant covering specific
              attendees. Selectable when adding or editing a registration.
            </CardDescription>
          </div>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 mr-1.5" /> Add Payer
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No billing accounts yet. Add one to bill a registration to an
            institution or company instead of the attendee.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>VAT / Tax No.</TableHead>
                <TableHead className="text-center">Registrations</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(accounts as Payer[]).map((p) => (
                <TableRow key={p.id} className={p.isActive ? "" : "opacity-60"}>
                  <TableCell className="font-medium">
                    {p.name}
                    {p.needsReview && (
                      <Badge variant="destructive" className="ml-2">Needs review</Badge>
                    )}
                  </TableCell>
                  <TableCell>{p.type}</TableCell>
                  <TableCell>{p.taxNumber || "—"}</TableCell>
                  <TableCell className="text-center">{p._count?.registrations ?? 0}</TableCell>
                  <TableCell className="text-center">
                    <button
                      onClick={() => toggleActive(p)}
                      disabled={togglingId === p.id}
                      className="text-xs underline text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {p.isActive ? "Active" : "Inactive"}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit billing account" : "Add billing account"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="ba-name">Name *</Label>
              <Input id="ba-name" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Cleveland Clinic / Pfizer MENA" />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v as Payer["type"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="INSTITUTION">Institution / Hospital</SelectItem>
                  <SelectItem value="COMPANY">Company / Pharma</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-tax">VAT / Tax Number</Label>
              <Input id="ba-tax" value={form.taxNumber}
                onChange={(e) => setForm({ ...form, taxNumber: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-contact">AP Contact Name</Label>
              <Input id="ba-contact" value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-email">Billing Email</Label>
              <Input id="ba-email" type="email" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-phone">Phone</Label>
              <Input id="ba-phone" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="ba-address">Address</Label>
              <Input id="ba-address" value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-city">City</Label>
              <Input id="ba-city" value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-country">Country</Label>
              <Input id="ba-country" value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-state">State</Label>
              <Input id="ba-state" value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ba-zip">Zip / Postal Code</Label>
              <Input id="ba-zip" value={form.zipCode}
                onChange={(e) => setForm({ ...form, zipCode: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="ba-notes">Internal Notes</Label>
              <Textarea id="ba-notes" rows={2} value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
