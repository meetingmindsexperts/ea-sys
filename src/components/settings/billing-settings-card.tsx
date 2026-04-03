"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Receipt } from "lucide-react";
import { toast } from "sonner";

interface BillingData {
  companyName: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyZipCode: string | null;
  companyCountry: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  taxId: string | null;
  invoicePrefix: string | null;
}

export function BillingSettingsCard() {
  const [data, setData] = useState<BillingData>({
    companyName: null, companyAddress: null, companyCity: null,
    companyState: null, companyZipCode: null, companyCountry: null,
    companyPhone: null, companyEmail: null, taxId: null, invoicePrefix: null,
  });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/organization").then(r => r.json()).then(org => {
      setData({
        companyName: org.companyName || null,
        companyAddress: org.companyAddress || null,
        companyCity: org.companyCity || null,
        companyState: org.companyState || null,
        companyZipCode: org.companyZipCode || null,
        companyCountry: org.companyCountry || null,
        companyPhone: org.companyPhone || null,
        companyEmail: org.companyEmail || null,
        taxId: org.taxId || null,
        invoicePrefix: org.invoicePrefix || null,
      });
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/organization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Billing information saved");
    } catch {
      toast.error("Failed to save billing information");
    } finally {
      setSaving(false);
    }
  };

  const update = (field: keyof BillingData, value: string) => {
    setData(prev => ({ ...prev, [field]: value || null }));
  };

  if (!loaded) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-emerald-50 text-emerald-600">
            <Receipt className="h-4 w-4" />
          </div>
          Billing &amp; Invoicing
        </CardTitle>
        <CardDescription>
          Company details displayed on invoices and receipts. These appear in the &quot;From&quot; section of all generated documents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="companyName">Company Name</Label>
            <Input
              id="companyName"
              value={data.companyName || ""}
              onChange={e => update("companyName", e.target.value)}
              placeholder="Legal company name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="taxId">Tax ID / VAT Number</Label>
            <Input
              id="taxId"
              value={data.taxId || ""}
              onChange={e => update("taxId", e.target.value)}
              placeholder="e.g. AE100123456"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="companyAddress">Address</Label>
          <Textarea
            id="companyAddress"
            value={data.companyAddress || ""}
            onChange={e => update("companyAddress", e.target.value)}
            placeholder="Street address"
            rows={2}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="companyCity">City</Label>
            <Input
              id="companyCity"
              value={data.companyCity || ""}
              onChange={e => update("companyCity", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyState">State / Province</Label>
            <Input
              id="companyState"
              value={data.companyState || ""}
              onChange={e => update("companyState", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyZipCode">Zip / Postal Code</Label>
            <Input
              id="companyZipCode"
              value={data.companyZipCode || ""}
              onChange={e => update("companyZipCode", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyCountry">Country</Label>
            <Input
              id="companyCountry"
              value={data.companyCountry || ""}
              onChange={e => update("companyCountry", e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="companyPhone">Phone</Label>
            <Input
              id="companyPhone"
              value={data.companyPhone || ""}
              onChange={e => update("companyPhone", e.target.value)}
              placeholder="+971 4 XXX XXXX"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyEmail">Billing Email</Label>
            <Input
              id="companyEmail"
              type="email"
              value={data.companyEmail || ""}
              onChange={e => update("companyEmail", e.target.value)}
              placeholder="billing@company.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoicePrefix">Invoice Number Prefix</Label>
            <Input
              id="invoicePrefix"
              value={data.invoicePrefix || ""}
              onChange={e => update("invoicePrefix", e.target.value)}
              placeholder="INV"
              maxLength={10}
            />
            <p className="text-xs text-muted-foreground">e.g. INV → INV-2026-0001</p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving} className="btn-gradient">
            {saving ? "Saving…" : "Save Billing Info"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
