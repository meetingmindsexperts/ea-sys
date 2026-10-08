"use client";

import { useState } from "react";
import { useCan } from "@/hooks/use-can";
import { fromLocalDateTimeInput, toLocalDateTimeInput } from "@/lib/datetime-local";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tag,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Copy,
  Percent,
  DollarSign,
  Link2,
} from "lucide-react";
import { promoRegistrationLink, sponsorCoverError } from "@/lib/promo-sponsor-cover";
import { toast } from "sonner";
import {
  usePromoCodes,
  useCreatePromoCode,
  useUpdatePromoCode,
  useDeletePromoCode,
  useTickets,
  useSponsors,
  useEvent,
} from "@/hooks/use-api";

interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: number;
  currency: string | null;
  maxUses: number | null;
  maxUsesPerEmail: number | null;
  usedCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
  // Redacted away for a non-finance role by the list route, hence optional:
  // the field can be absent rather than merely null.
  sponsorId?: string | null;
  /** The sponsor pays for everyone registering with this code (INCLUSIVE). */
  sponsorCoversFee?: boolean;
  ticketTypes: { ticketType: { id: string; name: string } }[];
  _count: { redemptions: number };
}

const emptyForm: {
  code: string;
  description: string;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: string;
  currency: string;
  maxUses: string;
  maxUsesPerEmail: string;
  validFrom: string;
  validUntil: string;
  isActive: boolean;
  ticketTypeIds: string[];
  /** "" means no sponsor. The server normalises it to NULL. */
  sponsorId: string;
  /** The sponsor pays: registrations become INCLUSIVE under the sponsor. */
  sponsorCoversFee: boolean;
} = {
  code: "",
  description: "",
  discountType: "PERCENTAGE",
  discountValue: "",
  currency: "USD",
  maxUses: "",
  maxUsesPerEmail: "1",
  validFrom: "",
  validUntil: "",
  isActive: true,
  ticketTypeIds: [],
  sponsorId: "",
  sponsorCoversFee: false,
};

/**
 * Radix `SelectItem` rejects value="" (it reserves the empty string for the
 * cleared state), so "no sponsor" needs a sentinel that is mapped back to ""
 * on the way in and out.
 */
const NO_SPONSOR = "__none__";

interface Props {
  eventId: string;
}

export function PromoCodesPanel({ eventId }: Props) {
  const { data: promoCodes = [], isLoading } = usePromoCodes(eventId);
  const { data: ticketTypes = [] } = useTickets(eventId);
  const { data: sponsorData } = useSponsors(eventId);
  const { data: event } = useEvent(eventId);
  const eventSlug = (event as { slug?: string } | undefined)?.slug;

  // The regular registration link with this code applied (Sep 29, 2026): what
  // a sponsor shares with their exhibitors, physicians, nurses...
  const copyRegistrationLink = (code: string) => {
    if (!eventSlug) return;
    navigator.clipboard.writeText(promoRegistrationLink(window.location.origin, eventSlug, code));
    toast.success("Registration link copied");
  };
  const sponsors = sponsorData?.sponsors ?? [];
  // The picker only exists when there is something to pick. That also decides
  // whether the payload carries `sponsorId` at all: sending "" from a form that
  // never rendered the control would silently clear an attribution set through
  // the API, and for a non-finance role the field is redacted away entirely, so
  // it would clear a value they cannot even see.
  const canAttribute = sponsors.length > 0;
  const createPromo = useCreatePromoCode(eventId);
  const updatePromo = useUpdatePromoCode(eventId);
  const deletePromo = useDeletePromoCode(eventId);
  const canWrite = useCan("promo.write", eventId) === "allowed";
  const canDelete = useCan("promo.delete", eventId) === "allowed";

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (promo: PromoCode) => {
    setEditingId(promo.id);
    setForm({
      code: promo.code,
      description: promo.description || "",
      discountType: promo.discountType,
      discountValue: String(promo.discountValue),
      currency: promo.currency || "USD",
      maxUses: promo.maxUses !== null ? String(promo.maxUses) : "",
      maxUsesPerEmail: promo.maxUsesPerEmail !== null ? String(promo.maxUsesPerEmail) : "",
      // `iso.slice(0, 16)` here dropped the UTC clock into an input the browser
      // reads as local, so every edit-and-save moved the window by the offset
      // and compounded. Same defect as the dinner console (review B2) and
      // the submission deadlines. Browser-local is the recorded semantics for
      // promo windows; see the note in src/lib/datetime-local.ts.
      validFrom: promo.validFrom ? toLocalDateTimeInput(promo.validFrom) : "",
      validUntil: promo.validUntil ? toLocalDateTimeInput(promo.validUntil) : "",
      isActive: promo.isActive,
      ticketTypeIds: promo.ticketTypes.map((t) => t.ticketType.id),
      sponsorId: promo.sponsorId ?? "",
      // Inert without a sponsor (deleted sponsor): open with the switch off.
      sponsorCoversFee: promo.sponsorCoversFee === true && !!promo.sponsorId,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.code.trim()) { toast.error("Code is required"); return; }
    if (!form.discountValue || Number(form.discountValue) <= 0) { toast.error("Discount value must be greater than 0"); return; }
    if (form.discountType === "PERCENTAGE" && Number(form.discountValue) > 100) { toast.error("Percentage cannot exceed 100%"); return; }
    const coverError = sponsorCoverError({
      sponsorCoversFee: form.sponsorCoversFee,
      sponsorId: form.sponsorId,
      discountType: form.discountType,
      discountValue: Number(form.discountValue),
      maxUses: form.maxUses ? Number(form.maxUses) : null,
    });
    if (coverError) { toast.error(coverError); return; }

    setSaving(true);
    try {
      const payload = {
        code: form.code.toUpperCase().trim(),
        description: form.description || undefined,
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        currency: form.discountType === "FIXED_AMOUNT" ? form.currency : undefined,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
        maxUsesPerEmail: form.maxUsesPerEmail ? Number(form.maxUsesPerEmail) : null,
        validFrom: fromLocalDateTimeInput(form.validFrom),
        validUntil: fromLocalDateTimeInput(form.validUntil),
        isActive: form.isActive,
        ticketTypeIds: form.ticketTypeIds.length > 0 ? form.ticketTypeIds : undefined,
        ...(canAttribute ? { sponsorId: form.sponsorId || null, sponsorCoversFee: form.sponsorCoversFee } : {}),
      };

      if (editingId) {
        await updatePromo.mutateAsync({ promoCodeId: editingId, data: payload });
        toast.success("Promo code updated");
      } else {
        await createPromo.mutateAsync(payload);
        toast.success("Promo code created");
      }
      setDialogOpen(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save promo code";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (promo: PromoCode) => {
    if (!confirm(`Delete promo code "${promo.code}"?`)) return;
    try {
      await deletePromo.mutateAsync(promo.id);
      toast.success(promo._count.redemptions > 0 ? "Promo code deactivated" : "Promo code deleted");
    } catch {
      toast.error("Failed to delete promo code");
    }
  };

  const activeCount = (promoCodes as PromoCode[]).filter((p) => p.isActive).length;
  const totalRedemptions = (promoCodes as PromoCode[]).reduce((sum, p) => sum + p._count.redemptions, 0);

  return (
    <div className="space-y-6">
      {/* Header + stats in one row */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="grid grid-cols-3 gap-4 flex-1 min-w-[320px]">
          <Card><CardContent className="py-4">
            <p className="text-sm text-slate-500">Total Codes</p>
            <p className="text-2xl font-bold text-slate-900">{(promoCodes as PromoCode[]).length}</p>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <p className="text-sm text-slate-500">Active</p>
            <p className="text-2xl font-bold text-emerald-600">{activeCount}</p>
          </CardContent></Card>
          <Card><CardContent className="py-4">
            <p className="text-sm text-slate-500">Total Redemptions</p>
            <p className="text-2xl font-bold text-primary">{totalRedemptions}</p>
          </CardContent></Card>
        </div>
        {canWrite && (
          <Button onClick={openCreate} className="btn-gradient">
            <Plus className="h-4 w-4 mr-1.5" /> Add Promo Code
          </Button>
        )}
      </div>

      {/* List */}
      {isLoading && (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      )}
      {!isLoading && ((promoCodes as PromoCode[]).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Tag className="h-10 w-10 mx-auto text-slate-300 mb-3" />
            <p className="text-slate-500">No promo codes yet</p>
            {canWrite && (
              <Button onClick={openCreate} variant="outline" className="mt-3">Create your first promo code</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(promoCodes as PromoCode[]).map((promo) => (
            <Card key={promo.id} className={!promo.isActive ? "opacity-60" : ""}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { navigator.clipboard.writeText(promo.code); toast.success("Copied!"); }}
                        className="font-mono text-lg font-bold text-slate-900 hover:text-primary transition-colors flex items-center gap-1.5"
                      >
                        {promo.code}
                        <Copy className="h-3.5 w-3.5 text-slate-400" />
                      </button>
                    </div>
                    <Badge variant={promo.discountType === "PERCENTAGE" ? "default" : "secondary"} className="flex items-center gap-1">
                      {promo.discountType === "PERCENTAGE" ? <Percent className="h-3 w-3" /> : <DollarSign className="h-3 w-3" />}
                      {promo.discountType === "PERCENTAGE" ? `${promo.discountValue}%` : `${promo.currency} ${Number(promo.discountValue).toFixed(2)}`}
                    </Badge>
                    {/* Review MED 2: a deleted sponsor (FK SetNull) leaves the flag
                        set but inert, so the badge follows the sponsor, not the flag. */}
                    {promo.sponsorCoversFee && promo.sponsorId && (
                      <Badge variant="outline" className="border-emerald-300 text-emerald-700">Sponsor pays</Badge>
                    )}
                    {!promo.isActive && <Badge variant="outline" className="text-slate-400">Inactive</Badge>}
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-sm font-medium text-slate-700">
                        {promo._count.redemptions}{promo.maxUses ? ` / ${promo.maxUses}` : ""} used
                      </p>
                      {promo.ticketTypes.length > 0 && (
                        <p className="text-xs text-slate-400 mt-0.5">
                          {promo.ticketTypes.map((t) => t.ticketType.name).join(", ")}
                        </p>
                      )}
                      {(promo.validFrom || promo.validUntil) && (
                        <p className="text-xs text-slate-400 mt-0.5">
                          {promo.validFrom ? new Date(promo.validFrom).toLocaleDateString() : "—"}
                          {" → "}
                          {promo.validUntil ? new Date(promo.validUntil).toLocaleDateString() : "—"}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {eventSlug && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Copy registration link with this code"
                          aria-label={`Copy registration link for ${promo.code}`}
                          onClick={() => copyRegistrationLink(promo.code)}
                        >
                          <Link2 className="h-4 w-4" />
                        </Button>
                      )}
                      {canWrite && (
                        <Button size="icon" variant="ghost" onClick={() => openEdit(promo)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(promo)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                {promo.description && (
                  <p className="text-sm text-slate-500 mt-2">{promo.description}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ))}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Promo Code" : "Create Promo Code"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Code <span className="text-red-400">*</span></Label>
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="e.g. EARLYBIRD20"
                className="uppercase font-mono"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Discount Type</Label>
                <Select value={form.discountType} onValueChange={(v) => setForm({ ...form, discountType: v as "PERCENTAGE" | "FIXED_AMOUNT" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                    <SelectItem value="FIXED_AMOUNT">Fixed Amount</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Value <span className="text-red-400">*</span></Label>
                <div className="relative">
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={form.discountType === "PERCENTAGE" ? "100" : undefined}
                    value={form.discountValue}
                    onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
                    placeholder={form.discountType === "PERCENTAGE" ? "e.g. 20" : "e.g. 50.00"}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                    {form.discountType === "PERCENTAGE" ? "%" : form.currency}
                  </span>
                </div>
              </div>
            </div>
            {form.discountType === "FIXED_AMOUNT" && (
              <div>
                <Label>Currency</Label>
                <Input
                  value={form.currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                  placeholder="USD"
                  maxLength={10}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Max Total Uses</Label>
                <Input
                  type="number"
                  min="1"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                  placeholder="Unlimited"
                />
              </div>
              <div>
                <Label>Max Uses Per Email</Label>
                <Input
                  type="number"
                  min="1"
                  value={form.maxUsesPerEmail}
                  onChange={(e) => setForm({ ...form, maxUsesPerEmail: e.target.value })}
                  placeholder="Unlimited"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Valid From</Label>
                <Input
                  type="datetime-local"
                  value={form.validFrom}
                  onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
                />
              </div>
              <div>
                <Label>Valid Until</Label>
                <Input
                  type="datetime-local"
                  value={form.validUntil}
                  onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                />
              </div>
            </div>
            {canAttribute && (
              <div>
                <Label>Sponsor</Label>
                <p className="text-xs text-slate-400 mb-2">
                  Everyone who registers with this code reports under that sponsor.
                </p>
                <Select
                  value={form.sponsorId || NO_SPONSOR}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      sponsorId: v === NO_SPONSOR ? "" : v,
                      // No sponsor, nobody to pay: the switch goes off with it.
                      sponsorCoversFee: v === NO_SPONSOR ? false : form.sponsorCoversFee,
                    })
                  }
                >
                  <SelectTrigger><SelectValue placeholder="No sponsor" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SPONSOR}>No sponsor</SelectItem>
                    {sponsors.map((sp) => (
                      <SelectItem key={sp.id} value={sp.id}>{sp.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {form.sponsorId && (
                  <div className="mt-3 rounded-md border border-slate-200 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={form.sponsorCoversFee}
                        onCheckedChange={(v) =>
                          setForm({
                            ...form,
                            sponsorCoversFee: v,
                            // The sponsor pays the whole fee, so the code is 100% off.
                            ...(v ? { discountType: "PERCENTAGE" as const, discountValue: "100" } : {}),
                          })
                        }
                      />
                      <Label>Sponsor covers the fee</Label>
                    </div>
                    <p className="text-xs text-slate-500">
                      Everyone who registers with this code is marked <strong>Inclusive</strong> under this
                      sponsor: no payment, no quote. Share the regular registration link with the code on
                      it (the link button on the code). Set <em>Max Total Uses</em> (required) to cap how many people the
                      sponsor can bring, and <em>Applicable Registration Types</em> for who they may register.
                    </p>
                  </div>
                )}
              </div>
            )}
            {(ticketTypes as { id: string; name: string }[]).length > 0 && (
              <div>
                <Label>Applicable Registration Types</Label>
                <p className="text-xs text-slate-400 mb-2">Leave empty to apply to all types</p>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {(ticketTypes as { id: string; name: string }[]).map((tt) => (
                    <label key={tt.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.ticketTypeIds.includes(tt.id)}
                        onChange={(e) => {
                          setForm({
                            ...form,
                            ticketTypeIds: e.target.checked
                              ? [...form.ticketTypeIds, tt.id]
                              : form.ticketTypeIds.filter((id) => id !== tt.id),
                          });
                        }}
                        className="rounded"
                      />
                      {tt.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="btn-gradient">
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editingId ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
