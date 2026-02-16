"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ClipboardList, Plus, Edit, Trash2, ArrowLeft } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useTickets, useCreateTicket, useUpdateTicket, useDeleteTicket } from "@/hooks/use-api";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  quantity: number;
  soldCount: number;
  maxPerOrder: number;
  salesStart: string | null;
  salesEnd: string | null;
  isActive: boolean;
  requiresApproval: boolean;
  _count: {
    registrations: number;
  };
}

export default function TicketsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  // React Query hooks - data is cached and shared across navigations
  const { data: tickets = [], isLoading: loading, isFetching } = useTickets(eventId);
  const createTicket = useCreateTicket(eventId);
  const updateTicket = useUpdateTicket(eventId);
  const deleteTicket = useDeleteTicket(eventId);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTicket, setEditingTicket] = useState<TicketType | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    price: 0,
    currency: "USD",
    quantity: 100,
    maxPerOrder: 10,
    isActive: true,
    requiresApproval: false,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingTicket) {
        await updateTicket.mutateAsync({ ticketId: editingTicket.id, data: formData });
        toast.success("Registration type updated successfully");
      } else {
        await createTicket.mutateAsync(formData);
        toast.success("Registration type created successfully");
      }
      setIsDialogOpen(false);
      resetForm();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Error saving registration type");
    }
  };

  const handleDelete = async (ticketId: string) => {
    if (!confirm("Are you sure you want to delete this registration type?")) return;

    try {
      await deleteTicket.mutateAsync(ticketId);
      toast.success("Registration type deleted successfully");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Error deleting registration type");
    }
  };

  const openEditDialog = (ticket: TicketType) => {
    setEditingTicket(ticket);
    setFormData({
      name: ticket.name,
      description: ticket.description || "",
      price: Number(ticket.price),
      currency: ticket.currency,
      quantity: ticket.quantity,
      maxPerOrder: ticket.maxPerOrder,
      isActive: ticket.isActive,
      requiresApproval: ticket.requiresApproval,
    });
    setIsDialogOpen(true);
  };

  const resetForm = () => {
    setEditingTicket(null);
    setFormData({
      name: "",
      description: "",
      price: 0,
      currency: "USD",
      quantity: 100,
      maxPerOrder: 10,
      isActive: true,
      requiresApproval: false,
    });
  };

  const stats = {
    total: tickets.length,
    active: tickets.filter((t) => t.isActive).length,
    totalSold: tickets.reduce((acc, t) => acc + t.soldCount, 0),
    totalRevenue: tickets.reduce(
      (acc, t) => acc + t.soldCount * Number(t.price),
      0
    ),
  };

  const showDelayedLoader = useDelayedLoading(loading, 1000);

  if (loading) {
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
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/events/${eventId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <ClipboardList className="h-8 w-8" />
              Registration Types
              {isFetching && !loading && (
                <span className="ml-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              )}
            </h1>
          </div>
          <p className="text-muted-foreground">
            Manage registration types and pricing for your event
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={(open) => {
          setIsDialogOpen(open);
          if (!open) resetForm();
        }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Registration Type
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>
                {editingTicket ? "Edit Registration Type" : "Create Registration Type"}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder="e.g., Early Bird, VIP, Standard"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  placeholder="What's included with this ticket..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="price">Price</Label>
                  <Input
                    id="price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.price}
                    onChange={(e) =>
                      setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="currency">Currency</Label>
                  <Input
                    id="currency"
                    value={formData.currency}
                    onChange={(e) =>
                      setFormData({ ...formData, currency: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quantity">Total Quantity</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min="1"
                    value={formData.quantity}
                    onChange={(e) =>
                      setFormData({ ...formData, quantity: parseInt(e.target.value) || 1 })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxPerOrder">Max Per Order</Label>
                  <Input
                    id="maxPerOrder"
                    type="number"
                    min="1"
                    value={formData.maxPerOrder}
                    onChange={(e) =>
                      setFormData({ ...formData, maxPerOrder: parseInt(e.target.value) || 1 })
                    }
                  />
                </div>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) =>
                      setFormData({ ...formData, isActive: e.target.checked })
                    }
                  />
                  <span className="text-sm">Active</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.requiresApproval}
                    onChange={(e) =>
                      setFormData({ ...formData, requiresApproval: e.target.checked })
                    }
                  />
                  <span className="text-sm">Requires Approval</span>
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit">
                  {editingTicket ? "Save Changes" : "Create Registration Type"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Types
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{stats.active}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Registrations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSold}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(stats.totalRevenue)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Registration Types List */}
      <div>
        <h2 className="text-lg font-semibold mb-4">All Registration Types</h2>
        {tickets.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-muted-foreground text-center py-8">
                No registration types yet. Click &quot;Add Registration Type&quot; to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {tickets.map((ticket) => (
              <Card key={ticket.id} className="hover:border-primary transition-colors">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">{ticket.name}</h3>
                        <Badge
                          variant="outline"
                          className={
                            ticket.isActive
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-800"
                          }
                        >
                          {ticket.isActive ? "Active" : "Inactive"}
                        </Badge>
                        {ticket.requiresApproval && (
                          <Badge variant="outline" className="bg-yellow-100 text-yellow-800">
                            Approval Required
                          </Badge>
                        )}
                      </div>

                      {ticket.description && (
                        <p className="text-sm text-muted-foreground mb-3">
                          {ticket.description}
                        </p>
                      )}

                      <div className="flex flex-wrap gap-6 text-sm">
                        <div>
                          <span className="text-muted-foreground">Price: </span>
                          <span className="font-semibold">
                            {formatCurrency(Number(ticket.price), ticket.currency)}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Registrations: </span>
                          <span className="font-semibold">
                            {ticket.soldCount}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Capacity: </span>
                          <span className="font-semibold">{ticket.quantity}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Max per order: </span>
                          <span className="font-semibold">{ticket.maxPerOrder}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEditDialog(ticket)}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(ticket.id)}
                        disabled={ticket._count.registrations > 0}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
