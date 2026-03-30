"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ClipboardList,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Link2,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  useTickets,
  useCreateTicket,
  useUpdateTicket,
  useDeleteTicket,
  useEvent,
  queryKeys,
} from "@/hooks/use-api";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useMutation } from "@tanstack/react-query";

const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => ({ default: m.TiptapEditor })),
  { ssr: false, loading: () => <div className="h-[200px] border rounded-md animate-pulse bg-muted/50" /> }
);

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

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function TicketsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const queryClient = useQueryClient();
  const { data: ticketTypesData = [], isLoading, isFetching } = useTickets(eventId);
  const ticketTypes = ticketTypesData as TicketType[];
  const createTicket = useCreateTicket(eventId);
  const updateTicket = useUpdateTicket(eventId);
  const deleteTicket = useDeleteTicket(eventId);
  const { data: event } = useEvent(eventId);
  const [copiedTier, setCopiedTier] = useState<string | null>(null);
  const [utmDialogOpen, setUtmDialogOpen] = useState(false);
  const [utmTier, setUtmTier] = useState("");
  const [utmSource, setUtmSource] = useState("");
  const [utmMedium, setUtmMedium] = useState("");
  const [utmCampaign, setUtmCampaign] = useState("");

  const invalidateAndRefetch = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tickets(eventId) });
  };

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

  // Terms & conditions WYSIWYG state
  const [termsHtml, setTermsHtml] = useState<string>("");
  const [termsLoaded, setTermsLoaded] = useState(false);

  useEffect(() => {
    if (event && !termsLoaded) {
      setTermsHtml((event as Record<string, unknown>).registrationTermsHtml as string || "");
      setTermsLoaded(true);
    }
  }, [event, termsLoaded]);

  const saveTerms = useMutation({
    mutationFn: async (html: string) => {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationTermsHtml: html || null }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      toast.success("Terms & conditions saved");
    },
    onError: () => toast.error("Failed to save terms"),
  });

  const handleSaveTerms = useCallback(() => {
    saveTerms.mutate(termsHtml);
  }, [termsHtml, saveTerms]);

  // Welcome text WYSIWYG state
  const [welcomeHtml, setWelcomeHtml] = useState<string>("");
  const [welcomeLoaded, setWelcomeLoaded] = useState(false);

  useEffect(() => {
    if (event && !welcomeLoaded) {
      setWelcomeHtml((event as Record<string, unknown>).registrationWelcomeHtml as string || "");
      setWelcomeLoaded(true);
    }
  }, [event, welcomeLoaded]);

  const saveWelcome = useMutation({
    mutationFn: async (html: string) => {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationWelcomeHtml: html || null }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      toast.success("Welcome text saved");
    },
    onError: () => toast.error("Failed to save welcome text"),
  });

  const handleSaveWelcome = useCallback(() => {
    saveWelcome.mutate(welcomeHtml);
  }, [welcomeHtml, saveWelcome]);

  // Post-registration confirmation text WYSIWYG state
  const [confirmationHtml, setConfirmationHtml] = useState<string>("");
  const [confirmationLoaded, setConfirmationLoaded] = useState(false);

  useEffect(() => {
    if (event && !confirmationLoaded) {
      setConfirmationHtml((event as Record<string, unknown>).registrationConfirmationHtml as string || "");
      setConfirmationLoaded(true);
    }
  }, [event, confirmationLoaded]);

  const saveConfirmation = useMutation({
    mutationFn: async (html: string) => {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationConfirmationHtml: html || null }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      toast.success("Confirmation text saved");
    },
    onError: () => toast.error("Failed to save confirmation text"),
  });

  const handleSaveConfirmation = useCallback(() => {
    saveConfirmation.mutate(confirmationHtml);
  }, [confirmationHtml, saveConfirmation]);

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
    } catch (err) { console.error("[tickets] operation failed", err); toast.error("Failed to update"); }
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
      invalidateAndRefetch();
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
      invalidateAndRefetch();
    } catch (err) { console.error("[tickets] operation failed", err); toast.error("Failed to update"); }
  };

  const handleDeleteTier = async (ticketTypeId: string, tier: PricingTier) => {
    if (tier._count.registrations > 0) { toast.error("Cannot delete with existing registrations"); return; }
    if (!confirm(`Delete "${tier.name}"?`)) return;
    try {
      const res = await fetch(`/api/events/${eventId}/tickets/${ticketTypeId}/tiers/${tier.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      toast.success("Pricing tier deleted");
      invalidateAndRefetch();
    } catch (err) { console.error("[tickets] operation failed", err); toast.error("Failed to delete"); }
  };

  const totalRegs = ticketTypes.reduce((sum, tt) => sum + tt._count.registrations, 0);

  const DEFAULT_TYPES = ["Physician", "Allied Health", "Student", "Resident", "Member"];
  const DEFAULT_TIERS = ["Early Bird", "Standard", "Onsite", "Presenter"];

  const handleSeedDefaults = async () => {
    const existingNames = new Set(ticketTypes.map((tt) => tt.name));
    const missing = DEFAULT_TYPES.filter((name) => !existingNames.has(name));

    if (missing.length === 0) {
      // Check if existing types are missing tiers
      let tiersAdded = 0;
      for (const tt of ticketTypes) {
        const existingTierNames = new Set(tt.pricingTiers.map((t) => t.name));
        const missingTiers = DEFAULT_TIERS.filter((n) => !existingTierNames.has(n));
        for (const tierName of missingTiers) {
          try {
            const res = await fetch(`/api/events/${eventId}/tickets/${tt.id}/tiers`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: tierName, price: 0, isActive: false }),
            });
            if (res.ok) tiersAdded++;
          } catch (err) { console.error("[tickets] operation failed", err); }
        }
      }
      if (tiersAdded > 0) {
        toast.success(`Added ${tiersAdded} missing pricing tiers`);
      } else {
        toast.info("All default types and tiers already exist");
      }
      invalidateAndRefetch();
      return;
    }

    try {
      for (const name of missing) {
        await createTicket.mutateAsync({
          name,
          pricingTiers: DEFAULT_TIERS.map((tierName, i) => ({
            name: tierName,
            price: 0,
            isActive: false,
            sortOrder: i,
          })),
        });
      }
      toast.success(`Added ${missing.length} registration types with pricing tiers`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to seed defaults");
    }
  };

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
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={invalidateAndRefetch} disabled={isFetching} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="outline" onClick={handleSeedDefaults}>
            <Plus className="mr-2 h-4 w-4" />
            Seed Defaults
          </Button>
          <Button variant="outline" onClick={() => { setUtmDialogOpen(true); setUtmTier(""); setUtmSource(""); setUtmMedium(""); setUtmCampaign(""); }}>
            <Link2 className="mr-2 h-4 w-4" />
            UTM Link Builder
          </Button>
          <Button onClick={openCreateType}>
            <Plus className="mr-2 h-4 w-4" />
            Add Type
          </Button>
        </div>
      </div>

      {/* Registration form overview link */}
      {event?.slug && (
        <div className="flex items-center gap-2 bg-slate-50 rounded-lg border border-slate-200 p-3">
          <span className="text-xs font-medium text-slate-500 shrink-0">Forms overview:</span>
          <code className="flex-1 text-xs text-slate-500 truncate">/e/{event.slug}/register</code>
          <Button variant="outline" size="sm" className="h-7 text-xs shrink-0"
            onClick={() => {
              navigator.clipboard.writeText(`${window.location.origin}/e/${event.slug}/register`);
              toast.success("Overview link copied");
            }}>
            <Copy className="h-3 w-3 mr-1" /> Copy
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" asChild>
            <a href={`/e/${event.slug}/register`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3 mr-1" /> Open
            </a>
          </Button>
        </div>
      )}

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
                          <span className="text-sm font-semibold text-slate-700 shrink-0">
                            {formatCurrency(Number(tier.price), tier.currency)}
                          </span>

                          {/* Copy form link */}
                          {event?.slug && (
                            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0"
                              title="Copy registration form link"
                              onClick={() => {
                                const url = `${window.location.origin}/e/${event.slug}/register/${toSlug(tier.name)}`;
                                navigator.clipboard.writeText(url);
                                setCopiedTier(tier.id);
                                toast.success(`Copied ${tier.name} form link`);
                                setTimeout(() => setCopiedTier(null), 2000);
                              }}>
                              {copiedTier === tier.id ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                            </Button>
                          )}

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
          <li className="flex gap-2.5">
            <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">4</span>
            <span>The main registration link (<code className="text-xs bg-white px-1.5 py-0.5 rounded border">/e/slug/register</code>) auto-redirects to the active tier (Early Bird → Standard → Onsite). <strong>Presenter</strong> is separate — share its direct link manually via email or your website.</span>
          </li>
        </ul>
      </div>

      {/* Registration Welcome Text Editor */}
      <Card>
        <CardContent className="pt-5 pb-4 px-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Registration Welcome Text</h3>
              <p className="text-xs text-muted-foreground">Shown on step 1 of the public registration form, above the account creation fields.</p>
            </div>
            <Button size="sm" onClick={handleSaveWelcome} disabled={saveWelcome.isPending}>
              {saveWelcome.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
          <TiptapEditor content={welcomeHtml} onChange={setWelcomeHtml} />
        </CardContent>
      </Card>

      {/* Post-Registration Confirmation Text Editor */}
      <Card>
        <CardContent className="pt-5 pb-4 px-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Post-Registration Confirmation Text</h3>
              <p className="text-xs text-muted-foreground">Shown on the confirmation page after a registrant completes registration.</p>
            </div>
            <Button size="sm" onClick={handleSaveConfirmation} disabled={saveConfirmation.isPending}>
              {saveConfirmation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
          <TiptapEditor content={confirmationHtml} onChange={setConfirmationHtml} />
        </CardContent>
      </Card>

      {/* Terms & Conditions Editor */}
      <Card>
        <CardContent className="pt-5 pb-4 px-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Terms & Conditions</h3>
              <p className="text-xs text-muted-foreground">Shown on the public registration form. Registrants must agree before submitting.</p>
            </div>
            <Button size="sm" onClick={handleSaveTerms} disabled={saveTerms.isPending}>
              {saveTerms.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
          <TiptapEditor content={termsHtml} onChange={setTermsHtml} />
        </CardContent>
      </Card>

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
              <TiptapEditor content={typeDesc} onChange={setTypeDesc} />
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

      {/* UTM Link Builder Dialog */}
      <Dialog open={utmDialogOpen} onOpenChange={setUtmDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>UTM Link Builder</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Generate a tracked registration link for sharing on websites, social media, or email campaigns.
            </p>

            <div className="space-y-2">
              <Label>Registration Form *</Label>
              <Select value={utmTier} onValueChange={setUtmTier}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a form" />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    const tierNames = new Set<string>();
                    ticketTypes.forEach((tt) => tt.pricingTiers.forEach((t) => tierNames.add(t.name)));
                    return [...tierNames].map((name) => (
                      <SelectItem key={name} value={toSlug(name)}>{name}</SelectItem>
                    ));
                  })()}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Source *</Label>
              <div className="flex flex-wrap gap-2 mb-2">
                {["linkedin", "instagram", "facebook", "twitter", "mailchimp", "website"].map((s) => (
                  <Button key={s} size="sm" variant={utmSource === s ? "default" : "outline"}
                    onClick={() => setUtmSource(s)} className="text-xs h-7 capitalize">{s}</Button>
                ))}
              </div>
              <Input placeholder="Or enter custom source" value={utmSource}
                onChange={(e) => setUtmSource(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Medium *</Label>
              <div className="flex flex-wrap gap-2 mb-2">
                {["social", "email", "website", "paid", "referral"].map((m) => (
                  <Button key={m} size="sm" variant={utmMedium === m ? "default" : "outline"}
                    onClick={() => setUtmMedium(m)} className="text-xs h-7 capitalize">{m}</Button>
                ))}
              </div>
              <Input placeholder="Or enter custom medium" value={utmMedium}
                onChange={(e) => setUtmMedium(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Campaign</Label>
              <Input placeholder="e.g., ehc2026-launch, early-bird-promo" value={utmCampaign}
                onChange={(e) => setUtmCampaign(e.target.value)} />
            </div>

            {/* Generated URL preview */}
            {utmTier && utmSource && utmMedium && event?.slug && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Generated Link</Label>
                <div className="bg-slate-50 rounded-lg border border-slate-200 p-3">
                  <code className="text-xs text-slate-700 break-all">
                    {(() => {
                      const base = `${typeof window !== "undefined" ? window.location.origin : ""}/e/${event.slug}/register/${utmTier}`;
                      const params = new URLSearchParams();
                      params.set("utm_source", utmSource);
                      params.set("utm_medium", utmMedium);
                      if (utmCampaign) params.set("utm_campaign", utmCampaign);
                      return `${base}?${params.toString()}`;
                    })()}
                  </code>
                </div>
                <Button className="w-full" onClick={() => {
                  const base = `${window.location.origin}/e/${event.slug}/register/${utmTier}`;
                  const params = new URLSearchParams();
                  params.set("utm_source", utmSource);
                  params.set("utm_medium", utmMedium);
                  if (utmCampaign) params.set("utm_campaign", utmCampaign);
                  navigator.clipboard.writeText(`${base}?${params.toString()}`);
                  toast.success("Link copied to clipboard");
                }}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Link
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
