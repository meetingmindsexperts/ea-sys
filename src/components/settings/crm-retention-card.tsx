"use client";

/**
 * CRM data retention for THIS organisation (src/crm/lib/retention-rules.ts):
 * how long email threads and notes are kept before the nightly job deletes
 * them. Off by default; blank means keep forever. Super admin only (the API
 * takes the purge gate), and only shown when the organisation has the CRM.
 * Reads and writes /api/crm/retention, so core imports nothing from the CRM.
 */
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Retention = { emailMonths: number | null; notesMonths: number | null };

const toField = (v: number | null) => (v === null ? "" : String(v));
const fromField = (v: string) => (v.trim() === "" ? null : Number(v));

export function CrmRetentionCard() {
  const [email, setEmail] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/crm/retention")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { retention: Retention };
        if (!live) return;
        setEmail(toField(body.retention.emailMonths));
        setNotes(toField(body.retention.notesMonths));
      })
      .catch(() => live && setHidden(true));
    return () => {
      live = false;
    };
  }, []);

  if (hidden || email === null) return null;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/crm/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailMonths: fromField(email ?? ""), notesMonths: fromField(notes) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 400 ? "Each period must be a whole number of months from 12 to 120, or blank" : (body.error ?? "Could not save"));
        return;
      }
      toast.success("CRM retention saved");
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
            <Clock className="h-4 w-4" />
          </div>
          CRM data retention
        </CardTitle>
        <CardDescription>
          How long the CRM keeps sponsor email and notes. Blank keeps them forever (the default). When set, a nightly job
          permanently deletes email threads whose last message is older, with their attachments, and notes older than
          the period. Deals, accounts, contacts and quotes are never deleted by age.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3 sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="crm-retention-email">Email threads (months)</Label>
          <Input id="crm-retention-email" name="emailMonths" inputMode="numeric" placeholder="Keep forever" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="crm-retention-notes">Notes (months)</Label>
          <Input id="crm-retention-notes" name="notesMonths" inputMode="numeric" placeholder="Keep forever" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <Button disabled={saving} onClick={save}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
