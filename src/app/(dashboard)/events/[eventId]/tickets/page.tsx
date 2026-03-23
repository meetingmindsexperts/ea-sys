"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  ClipboardList,
  Plus,
  Pencil,
  Trash2,
  DollarSign,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  useTickets,
  useCreateTicket,
  useUpdateTicket,
  useDeleteTicket,
} from "@/hooks/use-api";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

interface PricingTier {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
  maxPerOrder: number;
  salesStart: string | null;
  salesEnd: string | null;
  isActive: boolean;
  requiresApproval: boolean;
  sortOrder: number;
  _count: { registrations: number };
}

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  pricingTiers: PricingTier[];
  _count: { registrations: number };
}

const DEFAULT_TIER_NAMES = ["Early Bird", "Standard", "Onsite", "Presenter"];

export default function TicketsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const { data: ticketTypesData = [], isLoading, isFetching, refetch } = useTickets(eventId);
  const ticketTypes = ticketTypesData as TicketType[];
  const createTicket = useCreateTicket(eventId);
  const updateTicket = useUpdateTicket(eventId);
  const deleteTicket = useDeleteTicket(eventId);

  const [typeDialogOpen, setTypeDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<TicketType | null>(null);
  const [typeName, setTypeName] = useState("");
  const [typeDesc, setTypeDesc] = useState("");

  const [tierDialogOpen, setTierDialogOpen] = useState(false);
  const [editingTier, setEditingTier] = useState<PricingTier | null>(null);
  const [tierParentId, setTierParentId] = useState("");
  const [tierForm, setTierForm] = useState({
    name: "",
    price: 0,
    currency: "USD",
    isActive: true,
    requiresApproval: false,
  });

  const showDelayedLoader = useDelayedLoading(isLoading, 1000);

  // Registration type CRUD
  const openCreateType = () => {
    setEditingType(null);
    setTypeName("");
    setTypeDesc("");
    setTypeDialogOpen(true);
  };

  const openEditType = (tt: TicketType) => {
    setEditingType(tt);
    setTypeName(tt.name);
    setTypeDesc(tt.description || "");
    setTypeDialogOpen(true);
  };

  const handleSaveType = async () => {
    if (!typeName.trim()) { toast.error("Name is required"); return; }
    try {
      if (editingType) {
        await updateTicket.mutateAsync({ ticketId: editingType.id, data: { name: typeName, description: typeDesc } });
        toast.success("Registration type updated");
      } else {
        await createTicket.mutateAsync({ name: typeName, description: typeDesc });
        toast.success("Registration type created");
      }
      setTypeDialogOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleDeleteType = async (tt: TicketType) => {
    if (tt._count.registrations > 0) { toast.error("Cannot delete with existing registrations"); return; }
    if (!confirm(`Delete "${tt.name}" and all its pricing tiers?`)) return;
    try {
      await deleteTicket.mutateAsync(tt.id);
      toast.success("Registration type deleted");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const toggleTypeActive = async (tt: TicketType) => {
    try {
      await updateTicket.mutateAsync({ ticketId: tt.id, data: { isActive: !tt.isActive } });
      toast.success(tt.isActive ? `"${tt.name}" hidden` : `"${tt.name}" visible`);
    } catch { toast.error("Failed to update"); }
  };

  // Pricing tier CRUD
  const openCreateTier = (ticketTypeId: string) => {
    setEditingTier(null);
    setTierParentId(ticketTypeId);
    setTierForm({ name: "", price: 0, currency: "USD", isActive: true, requiresApproval: false });
    setTierDialogOpen(true);
  };

  const openEditTier = (ticketTypeId: string, tier: PricingTier) => {
    setEditingTier(tier);
    setTierParentId(ticketTypeId);
    setTierForm({ name: tier.name, price: Number(tier.price), currency: tier.currency, isActive: tier.isActive, requiresApproval: tier.requiresApproval });
    setTierDialogOpen(true);
  };

  const handleSaveTier = async () => {
    if (!tierForm.name.trim()) { toast.error("Tier name is required"); return; }
    try {
      const url = editingTier
        ? `/api/events/${eventId}/tickets/${tierParentId}/tiers/${editingTier.id}`
        : `/api/events/${eventId}/tickets/${tierParentId}/tiers`;
      const res = await fetch(url, {
        method: editingTier ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tierForm),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed"); }
      toast.success(editingTier ? "Pricing tier updated" : "Pricing tier created");
      setTierDialogOpen(false);
      refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const toggleTierActive = async (ticketTypeId: string, tier: PricingTier) => {
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers/${tier.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !tier.isActive }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success(tier.isActive ? `"${tier.name}" deactivated` : `"${tier.name}" activated`);
      refetch();
    } catch { toast.error("Failed to update"); }
  };

  const handleDeleteTier = async (ticketTypeId: string, tier: PricingTier) => {
    if (tier._count.registrations > 0) { toast.error("Cannot delete with existing registrations"); return; }
    if (!confirm(`Delete "${tier.name}"?`)) return;
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers/${tier.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      toast.success("Pricing tier deleted");
      refetch();
    } catch { toast.error("Failed to delete"); }
  };

  const totalRegs = ticketTypes.reduce((sum, tt) => sum + tt._count.registrations, 0);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <ClipboardList className="h-8 w-8" />
            Registration Types
            {isFetching && !isLoading && (
              <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            {ticketTypes.length} types · {totalRegs} registrations
          </p>
        </div>
        <Button onClick={openCreateType}>
          <Plus className="mr-2 h-4 w-4" />
          Add Type
        </Button>
      </div>

      {/* 3-column grid */}
      {ticketTypes.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center py-8">
              No registration types yet. Click &quot;Add Type&quot; to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {ticketTypes.map((tt) => (
            <Card key={tt.id} className={!tt.isActive ? "opacity-50" : ""}>
              <CardContent className="pt-5 pb-4 px-5">
                {/* Card header */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-bold text-slate-900 truncate">{tt.name}</h3>
                      {tt.isDefault && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Default</Badge>}
                    </div>
                    {tt.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{tt.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {tt._count.registrations} registration{tt._count.registrations !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditType(tt)} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500 hover:text-red-700"
                      onClick={() => handleDeleteType(tt)} disabled={tt._count.registrations > 0} title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {/* Active toggle for the type */}
                <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-slate-50 mb-3">
                  <span className="text-xs font-medium text-slate-600">Visible in forms</span>
                  <Switch
                    checked={tt.isActive}
                    onCheckedChange={() => toggleTypeActive(tt)}
                    className="scale-90"
                  />
                </div>

                {/* Pricing tiers list */}
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Pricing Tiers</p>

                  {tt.pricingTiers.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-3 text-center">No tiers yet</p>
                  ) : (
                    <div className="space-y-1.5">
                      {tt.pricingTiers.map((tier) => (
                        <div
                          key={tier.id}
                          className={`flex items-center gap-2 py-2 px-3 rounded-lg border transition-colors ${
                            tier.isActive ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-50"
                          }`}
                        >
                          {/* Active checkbox */}
                          <Checkbox
                            checked={tier.isActive}
                            onCheckedChange={() => toggleTierActive(tt.id, tier)}
                            className="shrink-0"
                          />

                          {/* Tier info */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{tier.name}</p>
                          </div>

                          {/* Price */}
                          <div className="flex items-center gap-0.5 text-sm font-semibold text-slate-700 shrink-0">
                            <DollarSign className="h-3 w-3 text-slate-400" />
                            {formatCurrency(Number(tier.price), tier.currency)}
                          </div>

                          {/* Edit */}
                          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0"
                            onClick={() => openEditTier(tt.id, tier)} title="Edit tier">
                            <Pencil className="h-3 w-3" />
                          </Button>

                          {/* Delete */}
                          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-red-400 hover:text-red-600"
                            onClick={() => handleDeleteTier(tt.id, tier)} disabled={tier._count.registrations > 0} title="Delete tier">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <Button variant="outline" size="sm" className="w-full mt-2 h-8 text-xs"
                    onClick={() => openCreateTier(tt.id)}>
                    <Plus className="mr-1.5 h-3 w-3" />
                    Add Tier
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Instructions */}
      <div className="bg-slate-50 rounded-xl border border-slate-200 p-5">
        <h3 className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">How it works</h3>
        <ul className="space-y-2 text-sm text-slate-600">
          <li className="flex gap-2.5">
            <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">1</span>
            <span>Each <strong>registration type</strong> (Physician, Student, etc.) appears as an option on the public form. Toggle &quot;Visible in forms&quot; off to hide a type from all forms.</span>
          </li>
          <li className="flex gap-2.5">
            <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">2</span>
            <span>Each type has <strong>pricing tiers</strong> (Early Bird, Standard, Onsite, etc.). Each tier becomes a separate public registration form with its own shareable link.</span>
          </li>
          <li className="flex gap-2.5">
            <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">3</span>
            <span>Use the <strong>checkbox</strong> next to each tier to activate or close it. Unchecking a tier (e.g., Early Bird) closes that form for all registration types at once.</span>
          </li>
        </ul>
      </div>

      {/* Registration Type Dialog */}
      <Dialog open={typeDialogOpen} onOpenChange={setTypeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingType ? "Edit Registration Type" : "New Registration Type"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input placeholder="e.g., Physician, Allied Health, Student" value={typeName}
                onChange={(e) => setTypeName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea placeholder="Optional description" value={typeDesc}
                onChange={(e) => setTypeDesc(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTypeDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveType} disabled={createTicket.isPending || updateTicket.isPending}>
              {createTicket.isPending || updateTicket.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pricing Tier Dialog */}
      <Dialog open={tierDialogOpen} onOpenChange={setTierDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingTier ? "Edit Pricing Tier" : "New Pricing Tier"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Tier Name *</Label>
              {!editingTier ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {DEFAULT_TIER_NAMES.map((name) => (
                      <Button key={name} variant={tierForm.name === name ? "default" : "outline"}
                        size="sm" onClick={() => setTierForm({ ...tierForm, name })}>
                        {name}
                      </Button>
                    ))}
                  </div>
                  <Input placeholder="Or enter a custom tier name" value={tierForm.name}
                    onChange={(e) => setTierForm({ ...tierForm, name: e.target.value })} />
                </div>
              ) : (
                <Input value={tierForm.name} onChange={(e) => setTierForm({ ...tierForm, name: e.target.value })} />
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Price</Label>
                <Input type="number" min={0} step={0.01} value={tierForm.price}
                  onChange={(e) => setTierForm({ ...tierForm, price: Number(e.target.value) })} />
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <Input value={tierForm.currency}
                  onChange={(e) => setTierForm({ ...tierForm, currency: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <Checkbox id="tier-active" checked={tierForm.isActive}
                  onCheckedChange={(checked) => setTierForm({ ...tierForm, isActive: !!checked })} />
                <Label htmlFor="tier-active">Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="tier-approval" checked={tierForm.requiresApproval}
                  onCheckedChange={(checked) => setTierForm({ ...tierForm, requiresApproval: !!checked })} />
                <Label htmlFor="tier-approval">Requires Approval</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTierDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveTier}>{editingTier ? "Update" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
