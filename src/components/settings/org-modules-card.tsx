"use client";

/**
 * Which organisations have which modules (module-entitlements.ts). Platform
 * operator only: the route refuses anyone else, and the card only renders on
 * the operator's System tab. Switching a module off suspends it and deletes
 * nothing; switching it back on restores everything.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Blocks } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queryKeys, useOrganizations } from "@/hooks/use-api";

export function OrgModulesCard() {
  const qc = useQueryClient();
  const { data: orgs = [], isLoading, isError } = useOrganizations(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<{ id: string; name: string } | null>(null);

  async function toggle(orgId: string, orgName: string, enabled: boolean) {
    setSaving(orgId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/modules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: "crm", enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Could not change the module");
        return;
      }
      toast.success(`CRM ${enabled ? "switched on" : "switched off"} for ${orgName}`);
      await qc.invalidateQueries({ queryKey: queryKeys.organizations });
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setSaving(null);
    }
  }

  // Refused (not the platform operator) or not loaded yet: render nothing, so a
  // tenant's own SUPER_ADMIN never sees the card start to appear.
  if (isError || isLoading) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
            <Blocks className="h-4 w-4" />
          </div>
          Organisation modules
        </CardTitle>
        <CardDescription>
          Which organisations have the CRM. Switching it off hides the CRM and pauses its reminders and inbox for that
          organisation; no data is deleted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {orgs.map((org) => {
          const on = org.enabledModules?.includes("crm") ?? false;
          return (
            <div key={org.id} className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{org.name}</p>
                <p className="text-xs text-muted-foreground">{org.slug}</p>
              </div>
              <div className="flex items-center gap-4">
              <Button variant="outline" size="sm" onClick={() => setEmailFor({ id: org.id, name: org.name })}>
                CRM email
              </Button>
              <label className="flex items-center gap-2 text-sm">
                CRM
                <Switch
                  checked={on}
                  disabled={saving === org.id}
                  onCheckedChange={(v) => toggle(org.id, org.name, v)}
                  aria-label={`CRM for ${org.name}`}
                />
              </label>
              </div>
            </div>
          );
        })}
      </CardContent>
      {emailFor && <CrmEmailDialog org={emailFor} onClose={() => setEmailFor(null)} />}
    </Card>
  );
}

const FIELDS = [
  { key: "fromAddress", label: "From address", hint: "Every CRM email goes out under it. Must be an SES-verified identity." },
  { key: "fromName", label: "From name", hint: "Optional." },
  { key: "forwardTo", label: "Copy replies to", hint: "The shared mailbox a sponsor's reply is copied to. Defaults to the From address." },
  { key: "replyDomain", label: "Reply domain", hint: "Where tokenized Reply-To addresses live, with an SES receipt rule into the inbound bucket. Empty: no reply threading." },
  { key: "captureAddress", label: "Capture address", hint: "The secret address the mailbox rule copies mail to. Empty: no capture." },
] as const;
type FieldKey = (typeof FIELDS)[number]["key"];

/** One organisation's CRM email identity (src/lib/crm-email-identity.ts). */
function CrmEmailDialog({ org, onClose }: { org: { id: string; name: string }; onClose: () => void }) {
  const [values, setValues] = useState<Record<FieldKey, string> | null>(null);
  const [effective, setEffective] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/organizations/${org.id}/crm-email`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not load the CRM email settings");
        if (!live) return;
        const own = (body.crmEmail ?? {}) as Partial<Record<FieldKey, string | null>>;
        setValues(Object.fromEntries(FIELDS.map((f) => [f.key, own[f.key] ?? ""])) as Record<FieldKey, string>);
        setEffective(body.effective?.source ?? null);
      })
      .catch((err: Error) => {
        toast.error(err.message);
        onClose();
      });
    return () => {
      live = false;
    };
  }, [org.id, onClose]);

  async function save(clear: boolean) {
    if (!values) return;
    setBusy(true);
    try {
      const crmEmail = clear
        ? null
        : Object.fromEntries(FIELDS.map((f) => [f.key, values[f.key].trim() || null]).filter(([, v]) => v !== null));
      const res = await fetch(`/api/organizations/${org.id}/crm-email`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crmEmail }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Could not save the CRM email settings");
        return;
      }
      toast.success(clear ? `CRM email cleared for ${org.name}` : `CRM email saved for ${org.name}`);
      onClose();
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>CRM email for {org.name}</DialogTitle>
          <DialogDescription>
            {effective === "environment"
              ? "Currently taken from this deployment's environment. Saving here replaces it for this organisation."
              : "Only this organisation's mail uses these. Left empty, the CRM sends under the default sender and copies replies nowhere."}
          </DialogDescription>
        </DialogHeader>
        {!values ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={`crm-email-${f.key}`}>{f.label}</Label>
                <Input
                  id={`crm-email-${f.key}`}
                  name={f.key}
                  value={values[f.key]}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy || !values} onClick={() => save(true)}>
            Clear
          </Button>
          <Button disabled={busy || !values?.fromAddress.trim()} onClick={() => save(false)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
