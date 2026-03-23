"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ClipboardList,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Eye,
  EyeOff,
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

  // State
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
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

  const toggleExpand = (id: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
    if (!typeName.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      if (editingType) {
        await updateTicket.mutateAsync({
          ticketId: editingType.id,
          data: { name: typeName, description: typeDesc },
        });
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
    if (tt._count.registrations > 0) {
      toast.error("Cannot delete registration type with existing registrations");
      return;
    }
    if (!confirm(`Delete "${tt.name}" and all its pricing tiers?`)) return;
    try {
      await deleteTicket.mutateAsync(tt.id);
      toast.success("Registration type deleted");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
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
    setTierForm({
      name: tier.name,
      price: Number(tier.price),
      currency: tier.currency,
      isActive: tier.isActive,
      requiresApproval: tier.requiresApproval,
    });
    setTierDialogOpen(true);
  };

  const handleSaveTier = async () => {
    if (!tierForm.name.trim()) {
      toast.error("Tier name is required");
      return;
    }
    try {
      if (editingTier) {
        const res = await fetch(`/api/events/${eventId}/tickets/${tierParentId}/tiers/${editingTier.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tierForm),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to update tier");
        }
        toast.success("Pricing tier updated");
      } else {
        const res = await fetch(`/api/events/${eventId}/tickets/${tierParentId}/tiers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tierForm),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to create tier");
        }
        toast.success("Pricing tier created");
      }
      setTierDialogOpen(false);
      refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleDeleteTier = async (ticketTypeId: string, tier: PricingTier) => {
    if (tier._count.registrations > 0) {
      toast.error("Cannot delete tier with existing registrations");
      return;
    }
    if (!confirm(`Delete pricing tier "${tier.name}"?`)) return;
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers/${tier.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete tier");
      }
      toast.success("Pricing tier deleted");
      refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  // Stats
  const totalRegs = ticketTypes.reduce((sum, tt) => sum + tt._count.registrations, 0);
  const totalTiers = ticketTypes.reduce((sum, tt) => sum + tt.pricingTiers.length, 0);

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
            Manage registration types and their pricing tiers
          </p>
        </div>
        <Button onClick={openCreateType}>
          <Plus className="mr-2 h-4 w-4" />
          Add Registration Type
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Registration Types</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{ticketTypes.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pricing Tiers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalTiers}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Registrations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{totalRegs}</div>
          </CardContent>
        </Card>
      </div>

      {/* Registration Types */}
      {ticketTypes.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center py-8">
              No registration types yet. Click &quot;Add Registration Type&quot; to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {ticketTypes.map((tt) => {
            const isExpanded = expandedTypes.has(tt.id);
            return (
              <Card key={tt.id} className={!tt.isActive ? "opacity-60" : ""}>
                <CardHeader className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleExpand(tt.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </Button>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold">{tt.name}</h3>
                          {tt.isDefault && (
                            <Badge variant="secondary" className="text-xs">Default</Badge>
                          )}
                          {!tt.isActive && (
                            <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>
                          )}
                        </div>
                        {tt.description && (
                          <p className="text-sm text-muted-foreground">{tt.description}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        {tt._count.registrations} registration{tt._count.registrations !== 1 ? "s" : ""}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        · {tt.pricingTiers.length} tier{tt.pricingTiers.length !== 1 ? "s" : ""}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={tt.isActive ? "Hide from registration" : "Show in registration"}
                        onClick={async () => {
                          try {
                            await updateTicket.mutateAsync({
                              ticketId: tt.id,
                              data: { isActive: !tt.isActive },
                            });
                            toast.success(tt.isActive ? `"${tt.name}" hidden from registration` : `"${tt.name}" visible in registration`);
                          } catch {
                            toast.error("Failed to update");
                          }
                        }}
                      >
                        {tt.isActive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-muted-foreground" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditType(tt)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500 hover:text-red-700"
                        onClick={() => handleDeleteType(tt)}
                        disabled={tt._count.registrations > 0}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="pt-0">
                    <div className="border rounded-lg">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Pricing Tier</TableHead>
                            <TableHead>Price</TableHead>
                            <TableHead>Registrations</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="w-24" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tt.pricingTiers.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                                No pricing tiers yet. Add one to enable registration.
                              </TableCell>
                            </TableRow>
                          ) : (
                            tt.pricingTiers.map((tier) => (
                              <TableRow key={tier.id} className={!tier.isActive ? "opacity-50" : ""}>
                                <TableCell className="font-medium">{tier.name}</TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <DollarSign className="h-3 w-3 text-muted-foreground" />
                                    {formatCurrency(Number(tier.price), tier.currency)}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <span className={tier._count.registrations > 0 ? "font-semibold text-green-600" : ""}>
                                    {tier._count.registrations}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  <button
                                    type="button"
                                    className="cursor-pointer"
                                    title={tier.isActive ? "Click to deactivate" : "Click to activate"}
                                    onClick={async () => {
                                      try {
                                        const res = await fetch(`/api/events/${eventId}/tickets/${tt.id}/tiers/${tier.id}`, {
                                          method: "PUT",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ isActive: !tier.isActive }),
                                        });
                                        if (!res.ok) throw new Error("Failed");
                                        toast.success(tier.isActive ? `"${tier.name}" deactivated` : `"${tier.name}" activated`);
                                        refetch();
                                      } catch {
                                        toast.error("Failed to update");
                                      }
                                    }}
                                  >
                                    {tier.isActive ? (
                                      <Badge className="bg-green-100 text-green-800 hover:bg-green-200" variant="outline">Active</Badge>
                                    ) : (
                                      <Badge variant="outline" className="text-muted-foreground hover:bg-slate-100">Inactive</Badge>
                                    )}
                                  </button>
                                </TableCell>
                                <TableCell>
                                  <div className="flex gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7"
                                      onClick={() => openEditTier(tt.id, tier)}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-red-500 hover:text-red-700"
                                      onClick={() => handleDeleteTier(tt.id, tier)}
                                      disabled={tier._count.registrations > 0}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => openCreateTier(tt.id)}
                    >
                      <Plus className="mr-2 h-3.5 w-3.5" />
                      Add Pricing Tier
                    </Button>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Registration Type Dialog */}
      <Dialog open={typeDialogOpen} onOpenChange={setTypeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingType ? "Edit Registration Type" : "New Registration Type"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                placeholder="e.g., Physician, Allied Health, Student"
                value={typeName}
                onChange={(e) => setTypeName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="Optional description"
                value={typeDesc}
                onChange={(e) => setTypeDesc(e.target.value)}
              />
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
            <DialogTitle>
              {editingTier ? "Edit Pricing Tier" : "New Pricing Tier"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Tier Name *</Label>
              {!editingTier ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {DEFAULT_TIER_NAMES.map((name) => (
                      <Button
                        key={name}
                        variant={tierForm.name === name ? "default" : "outline"}
                        size="sm"
                        onClick={() => setTierForm({ ...tierForm, name })}
                      >
                        {name}
                      </Button>
                    ))}
                  </div>
                  <Input
                    placeholder="Or enter a custom tier name"
                    value={tierForm.name}
                    onChange={(e) => setTierForm({ ...tierForm, name: e.target.value })}
                  />
                </div>
              ) : (
                <Input
                  value={tierForm.name}
                  onChange={(e) => setTierForm({ ...tierForm, name: e.target.value })}
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Price</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={tierForm.price}
                  onChange={(e) => setTierForm({ ...tierForm, price: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <Input
                  value={tierForm.currency}
                  onChange={(e) => setTierForm({ ...tierForm, currency: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="tier-active"
                  checked={tierForm.isActive}
                  onCheckedChange={(checked) => setTierForm({ ...tierForm, isActive: !!checked })}
                />
                <Label htmlFor="tier-active">Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="tier-approval"
                  checked={tierForm.requiresApproval}
                  onCheckedChange={(checked) => setTierForm({ ...tierForm, requiresApproval: !!checked })}
                />
                <Label htmlFor="tier-approval">Requires Approval</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTierDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveTier}>
              {editingTier ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
