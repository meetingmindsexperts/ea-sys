"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TitleSelect } from "@/components/ui/title-select";
import { RoleSelect } from "@/components/ui/role-select";
import { CountrySelect } from "@/components/ui/country-select";
import { SpecialtySelect } from "@/components/ui/specialty-select";
import {
  Calendar,
  MapPin,
  CreditCard,
  CheckCircle,
  Pencil,
  Save,
  X,
  Barcode,
  ExternalLink,
  Download,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { ReloadingSpinner } from "@/components/ui/reloading-spinner";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

interface Registration {
  id: string;
  status: string;
  paymentStatus: string;
  qrCode: string | null;
  createdAt: string;
  event: {
    id: string;
    name: string;
    slug: string;
    startDate: string;
    endDate: string;
    venue: string | null;
    city: string | null;
    country: string | null;
    bannerImage: string | null;
    taxRate?: string | null;
    taxLabel?: string | null;
  };
  attendee: {
    title: string | null;
    role: string | null;
    firstName: string;
    lastName: string;
    email: string;
    organization: string | null;
    jobTitle: string | null;
    phone: string | null;
    city: string | null;
    country: string | null;
    specialty: string | null;
    dietaryReqs: string | null;
  };
  ticketType: { id: string; name: string; price?: string; currency?: string };
  pricingTier: { id: string; name: string; price: string; currency: string } | null;
  payments: { id: string; amount: string; currency: string; status: string; receiptUrl: string | null; createdAt: string }[];
}

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  CONFIRMED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-purple-100 text-purple-800",
};

export default function MyRegistrationPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Record<string, string | null>>({});
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const { data: registrations = [], isLoading } = useQuery<Registration[]>({
    queryKey: ["registrant", "registrations"],
    queryFn: async () => {
      const res = await fetch("/api/registrant/registrations");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ registrationId, attendee }: { registrationId: string; attendee: Record<string, string | null | undefined> }) => {
      const res = await fetch("/api/registrant/registrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationId, attendee }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["registrant", "registrations"] });
      setEditingId(null);
      toast.success("Details updated");
    },
    onError: (err: Error) => {
      console.error("[MyRegistration] Update failed:", err.message);
      toast.error(err.message);
    },
  });

  const startEdit = (reg: Registration) => {
    setEditingId(reg.id);
    setEditData({
      title: reg.attendee.title || "",
      role: reg.attendee.role || "",
      firstName: reg.attendee.firstName,
      lastName: reg.attendee.lastName,
      organization: reg.attendee.organization || "",
      jobTitle: reg.attendee.jobTitle || "",
      phone: reg.attendee.phone || "",
      city: reg.attendee.city || "",
      country: reg.attendee.country || "",
      specialty: reg.attendee.specialty || "",
      dietaryReqs: reg.attendee.dietaryReqs || "",
    });
  };

  const saveEdit = (registrationId: string) => {
    updateMutation.mutate({
      registrationId,
      attendee: {
        title: editData.title || undefined,
        role: editData.role || undefined,
        firstName: editData.firstName || undefined,
        lastName: editData.lastName || undefined,
        organization: editData.organization || undefined,
        jobTitle: editData.jobTitle || undefined,
        phone: editData.phone || undefined,
        city: editData.city || undefined,
        country: editData.country || undefined,
        specialty: editData.specialty || undefined,
        dietaryReqs: editData.dietaryReqs || undefined,
      },
    });
  };

  const showDelayedLoader = useDelayedLoading(isLoading, 1000);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        {showDelayedLoader ? <ReloadingSpinner /> : null}
      </div>
    );
  }

  if (registrations.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-slate-700">No Registrations</h2>
          <p className="text-muted-foreground mt-2">You don&apos;t have any event registrations yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-4">
      <div>
        <h1 className="text-2xl font-bold">My Registrations</h1>
        <p className="text-muted-foreground mt-1">View and manage your event registrations.</p>
      </div>

      {registrations.map((reg) => {
        const isEditing = editingId === reg.id;
        const price = Number(reg.pricingTier?.price ?? reg.ticketType?.price ?? 0);
        const currency = reg.pricingTier?.currency ?? reg.ticketType?.currency ?? "USD";
        const isPaid = reg.paymentStatus === "PAID";
        const isComplimentary = reg.paymentStatus === "COMPLIMENTARY" || price === 0;
        const isConfirmed = reg.status === "CONFIRMED";
        const showPayment = !isPaid && !isComplimentary && reg.status !== "CANCELLED";
        const regTaxRate = Number(reg.event.taxRate ?? 0);
        const regTaxAmount = regTaxRate > 0 ? price * regTaxRate / 100 : 0;
        const regTotal = price + regTaxAmount;
        const regHasTax = regTaxRate > 0;
        const regTaxLabel = reg.event.taxLabel || "VAT";

        return (
          <Card key={reg.id} className="overflow-hidden">
            {/* Event header */}
            <div className="bg-gradient-to-r from-primary/10 to-primary/5 px-6 py-4 border-b">
              <h2 className="text-lg font-semibold text-slate-900">{reg.event.name}</h2>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {format(new Date(reg.event.startDate), "MMM d, yyyy")}
                </span>
                {(reg.event.venue || reg.event.city) && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5" />
                    {[reg.event.venue, reg.event.city, reg.event.country].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>
              <div className="flex gap-2 mt-3">
                <Badge className={statusColors[reg.status]} variant="outline">{reg.status}</Badge>
                <Badge variant="outline">{reg.ticketType.name}</Badge>
                {reg.pricingTier && <Badge variant="secondary">{reg.pricingTier.name}</Badge>}
              </div>
            </div>

            <CardContent className="p-6 space-y-6">
              {/* Confirmation / Payment Section */}
              {(isConfirmed || isPaid) && !showPayment && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="h-6 w-6 text-green-600 shrink-0" />
                    <div>
                      <p className="font-semibold text-green-800">Registration Confirmed</p>
                      <p className="text-sm text-green-700">
                        {isComplimentary ? "Complimentary registration — no payment required." : "Payment received. You're all set!"}
                      </p>
                    </div>
                  </div>
                  {isPaid && price > 0 && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/api/registrant/registrations/${reg.id}/quote`} download>
                        <Download className="mr-2 h-3.5 w-3.5" /> Invoice
                      </a>
                    </Button>
                  )}
                </div>
              )}

              {showPayment && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CreditCard className="h-6 w-6 text-amber-600 shrink-0" />
                      <div>
                        <p className="font-semibold text-amber-800">Payment Required</p>
                        {regHasTax ? (
                          <div className="text-sm text-amber-700 space-y-0.5">
                            <p>Subtotal: {formatCurrency(price, currency)}</p>
                            <p>{regTaxLabel} ({regTaxRate}%): {formatCurrency(regTaxAmount, currency)}</p>
                            <p className="font-semibold">Total Due: {formatCurrency(regTotal, currency)}</p>
                          </div>
                        ) : (
                          <p className="text-sm text-amber-700">
                            Amount due: {formatCurrency(price, currency)}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      className="btn-gradient"
                      disabled={checkoutLoading === reg.id}
                      onClick={async () => {
                        setCheckoutLoading(reg.id);
                        try {
                          const res = await fetch(`/api/public/events/${reg.event.slug}/checkout`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ registrationId: reg.id }),
                          });
                          const data = await res.json();
                          if (!res.ok) {
                            toast.error(data.error || "Failed to create checkout session");
                            setCheckoutLoading(null);
                            return;
                          }
                          window.location.href = data.checkoutUrl;
                        } catch (err) {
                          console.error("[MyRegistration] Checkout failed:", err);
                          toast.error("Something went wrong. Please try again.");
                          setCheckoutLoading(null);
                        }
                      }}
                    >
                      {checkoutLoading === reg.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
                      Pay Now
                    </Button>
                  </div>
                </div>
              )}

              {/* Payment receipts (only if paid) */}
              {isPaid && reg.payments.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-700">Payment History</h3>
                  {reg.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-lg p-3">
                      <div>
                        <span className="font-medium">{formatCurrency(Number(p.amount), p.currency)}</span>
                        <span className="text-muted-foreground ml-2">{format(new Date(p.createdAt), "MMM d, yyyy")}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className="bg-green-100 text-green-800" variant="outline">{p.status}</Badge>
                        {p.receiptUrl && (
                          <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1 text-xs">
                            <ExternalLink className="h-3 w-3" /> Receipt
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Confirmation Number + Download Quote */}
              <div className="flex items-center justify-between bg-slate-50 rounded-lg p-3">
                <div className="flex items-center gap-3">
                  <Barcode className="h-5 w-5 text-slate-500" />
                  <div>
                    <p className="text-xs text-muted-foreground">Barcode</p>
                    <p className="font-mono text-sm font-medium tracking-wider">{reg.id.toUpperCase()}</p>
                  </div>
                </div>
                {price > 0 && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/registrant/registrations/${reg.id}/quote`} download>
                      <Download className="mr-2 h-3.5 w-3.5" /> Quote
                    </a>
                  </Button>
                )}
              </div>

              {/* Personal Details */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700">Personal Details</h3>
                  {!isEditing ? (
                    <Button variant="outline" size="sm" onClick={() => startEdit(reg)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                    </Button>
                  ) : (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => saveEdit(reg.id)} disabled={updateMutation.isPending} className="bg-green-600 hover:bg-green-700">
                        <Save className="mr-2 h-3.5 w-3.5" />
                        {updateMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditingId(null)} disabled={updateMutation.isPending}>
                        <X className="mr-2 h-3.5 w-3.5" /> Cancel
                      </Button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="grid gap-4">
                    <div className="grid grid-cols-[100px_1fr_1fr] gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Title</Label>
                        <TitleSelect value={editData.title || ""} onChange={(v) => setEditData({ ...editData, title: v })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">First Name</Label>
                        <Input value={editData.firstName || ""} onChange={(e) => setEditData({ ...editData, firstName: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Last Name</Label>
                        <Input value={editData.lastName || ""} onChange={(e) => setEditData({ ...editData, lastName: e.target.value })} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Email</Label>
                      <Input value={reg.attendee.email} disabled className="bg-muted" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Organization</Label>
                        <Input value={editData.organization || ""} onChange={(e) => setEditData({ ...editData, organization: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Position</Label>
                        <Input value={editData.jobTitle || ""} onChange={(e) => setEditData({ ...editData, jobTitle: e.target.value })} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Phone</Label>
                      <Input value={editData.phone || ""} onChange={(e) => setEditData({ ...editData, phone: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Country</Label>
                        <CountrySelect value={editData.country || ""} onChange={(v) => setEditData({ ...editData, country: v })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">City</Label>
                        <Input value={editData.city || ""} onChange={(e) => setEditData({ ...editData, city: e.target.value })} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Specialty</Label>
                        <SpecialtySelect value={editData.specialty || ""} onChange={(v) => setEditData({ ...editData, specialty: v })} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Role</Label>
                        <RoleSelect value={editData.role || ""} onChange={(v) => setEditData({ ...editData, role: v })} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Dietary Requirements</Label>
                      <Input value={editData.dietaryReqs || ""} onChange={(e) => setEditData({ ...editData, dietaryReqs: e.target.value })} />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">Name</span>
                      <p className="font-medium">{[reg.attendee.title, reg.attendee.firstName, reg.attendee.lastName].filter(Boolean).join(" ")}</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Email</span>
                      <p className="font-medium">{reg.attendee.email}</p>
                    </div>
                    {reg.attendee.organization && (
                      <div>
                        <span className="text-muted-foreground">Organization</span>
                        <p className="font-medium">{reg.attendee.organization}</p>
                      </div>
                    )}
                    {reg.attendee.jobTitle && (
                      <div>
                        <span className="text-muted-foreground">Position</span>
                        <p className="font-medium">{reg.attendee.jobTitle}</p>
                      </div>
                    )}
                    {reg.attendee.phone && (
                      <div>
                        <span className="text-muted-foreground">Phone</span>
                        <p className="font-medium">{reg.attendee.phone}</p>
                      </div>
                    )}
                    {reg.attendee.country && (
                      <div>
                        <span className="text-muted-foreground">Location</span>
                        <p className="font-medium">{[reg.attendee.city, reg.attendee.country].filter(Boolean).join(", ")}</p>
                      </div>
                    )}
                    {reg.attendee.specialty && (
                      <div>
                        <span className="text-muted-foreground">Specialty</span>
                        <p className="font-medium">{reg.attendee.specialty}</p>
                      </div>
                    )}
                    {reg.attendee.dietaryReqs && (
                      <div>
                        <span className="text-muted-foreground">Dietary Requirements</span>
                        <p className="font-medium">{reg.attendee.dietaryReqs}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
