"use client";

import { useState, useMemo } from "react";
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
import { ClipboardList, Plus, Edit, Trash2, ArrowLeft, Copy, ExternalLink } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useTickets, useCreateTicket, useUpdateTicket, useDeleteTicket, useEvent } from "@/hooks/use-api";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

const DEFAULT_CATEGORIES = ["Early Bird", "Standard", "Presenter", "Other"];
const CUSTOM_VALUE = "__custom__";

const CATEGORY_COLORS: Record<string, string> = {
  "Early Bird": "bg-orange-100 text-orange-800",
  Standard: "bg-blue-100 text-blue-800",
  Presenter: "bg-purple-100 text-purple-800",
  Other: "bg-gray-100 text-gray-800",
};

function getCategoryColor(category: string) {
  return CATEGORY_COLORS[category] || "bg-slate-100 text-slate-800";
}

function toSlug(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface TicketType {
  id: string;
  name: string;
  description: string | null;
  category: string;
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

interface CategoryGroup {
  category: string;
  slug: string;
  tickets: TicketType[];
  totalRegistrations: number;
  totalCapacity: number;
}

export default function TicketsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  // React Query hooks - data is cached and shared across navigations
  const { data: tickets = [], isLoading: loading, isFetching } = useTickets(eventId);
  const { data: event } = useEvent(eventId);
  const createTicket = useCreateTicket(eventId);
  const updateTicket = useUpdateTicket(eventId);
  const deleteTicket = useDeleteTicket(eventId);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTicket, setEditingTicket] = useState<TicketType | null>(null);
  const [categoryMode, setCategoryMode] = useState<"preset" | "custom">("preset");
  const [customCategory, setCustomCategory] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    category: "Standard",
    price: 0,
    currency: "USD",
    quantity: 10000,
    maxPerOrder: 100,
    isActive: true,
    requiresApproval: false,
  });

  // Build unique categories from existing tickets (for dropdown options)
  const existingCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const t of tickets) {
      if (t.category) cats.add(t.category);
    }
    return Array.from(cats);
  }, [tickets]);

  // Merge default + existing categories for dropdown (deduplicated)
  const dropdownOptions = useMemo(() => {
    const all = new Set([...DEFAULT_CATEGORIES, ...existingCategories]);
    return Array.from(all);
  }, [existingCategories]);

  // Group tickets by category for display
  const categoryGroups: CategoryGroup[] = useMemo(() => {
    const map = new Map<string, TicketType[]>();
    for (const t of tickets) {
      const cat = t.category || "Standard";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(t);
    }
    return Array.from(map.entries()).map(([category, tix]) => ({
      category,
      slug: toSlug(category),
      tickets: tix,
      totalRegistrations: tix.reduce((acc, t) => acc + t.soldCount, 0),
      totalCapacity: tix.reduce((acc, t) => acc + t.quantity, 0),
    }));
  }, [tickets]);

  const handleCategorySelect = (value: string) => {
    if (value === CUSTOM_VALUE) {
      setCategoryMode("custom");
      setCustomCategory("");
      setFormData({ ...formData, category: "" });
    } else {
      setCategoryMode("preset");
      setCustomCategory("");
      setFormData({ ...formData, category: value });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalCategory = categoryMode === "custom" ? customCategory.trim() : formData.category;
    if (!finalCategory) {
      toast.error("Category is required");
      return;
    }
    try {
      const payload = { ...formData, category: finalCategory };
      if (editingTicket) {
        await updateTicket.mutateAsync({ ticketId: editingTicket.id, data: payload });
        toast.success("Registration type updated successfully");
      } else {
        await createTicket.mutateAsync(payload);
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
    const cat = ticket.category || "Standard";
    const isPreset = dropdownOptions.includes(cat);
    setCategoryMode(isPreset ? "preset" : "custom");
    setCustomCategory(isPreset ? "" : cat);
    setFormData({
      name: ticket.name,
      description: ticket.description || "",
      category: isPreset ? cat : "",
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
    setCategoryMode("preset");
    setCustomCategory("");
    setFormData({
      name: "",
      description: "",
      category: "Standard",
      price: 0,
      currency: "USD",
      quantity: 10000,
      maxPerOrder: 100,
      isActive: true,
      requiresApproval: false,
    });
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
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

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

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
            Manage registration types and pricing for your event. Each category gets its own registration form.
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
          <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl">
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
                  placeholder="e.g., Physician, Allied Health, Student"
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
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <p className="text-xs text-muted-foreground">
                  Tickets in the same category share one registration form page
                </p>
                <select
                  id="category"
                  aria-label="Category"
                  value={categoryMode === "custom" ? CUSTOM_VALUE : formData.category}
                  onChange={(e) => handleCategorySelect(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {dropdownOptions.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                  <option value={CUSTOM_VALUE}>+ Custom Category</option>
                </select>
                {categoryMode === "custom" && (
                  <Input
                    autoFocus
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    placeholder="Enter custom category name, e.g. VIP, Student, Government"
                    required
                  />
                )}
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
              {/* Capacity and Max Per Order hidden for now */}
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

      {/* Registration Types — Grouped by Category */}
      {tickets.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center py-8">
              No registration types yet. Click &quot;Add Registration Type&quot; to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {categoryGroups.map((group) => {
            const regUrl = event?.slug
              ? `${baseUrl}/e/${event.slug}/register/${group.slug}`
              : null;

            return (
              <div key={group.category}>
                {/* Category Header */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold">{group.category}</h2>
                    <Badge variant="outline" className={getCategoryColor(group.category)}>
                      {group.tickets.length} {group.tickets.length === 1 ? "type" : "types"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {group.totalRegistrations} registrations
                    </span>
                  </div>
                </div>

                {/* Shareable URL for this category */}
                {regUrl && (
                  <div className="flex items-center gap-2 mb-4 bg-muted/50 rounded-lg px-3 py-2">
                    <span className="text-xs text-muted-foreground shrink-0">Registration link:</span>
                    <code className="text-xs text-primary truncate flex-1">{regUrl}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 shrink-0"
                      onClick={() => copyUrl(regUrl)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <a
                      href={regUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${group.category} registration page`}
                      className="shrink-0"
                    >
                      <Button variant="ghost" size="sm" className="h-7 px-2">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  </div>
                )}

                {/* Ticket cards */}
                <div className="grid gap-3">
                  {group.tickets.map((ticket) => (
                    <Card key={ticket.id} className="transition-all duration-200 hover:border-primary/50 hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.04)] hover:-translate-y-0.5">
                      <CardContent className="pt-5 pb-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-1.5">
                              <h3 className="text-base font-semibold">{ticket.name}</h3>
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
                              <p className="text-sm text-muted-foreground mb-2">
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
