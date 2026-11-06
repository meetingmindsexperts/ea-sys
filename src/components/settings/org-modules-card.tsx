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
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { queryKeys, useOrganizations } from "@/hooks/use-api";

export function OrgModulesCard() {
  const qc = useQueryClient();
  const { data: orgs = [], isLoading, isError } = useOrganizations(true);
  const [saving, setSaving] = useState<string | null>(null);

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
    } finally {
      setSaving(null);
    }
  }

  // Refused (not the platform operator): render nothing rather than an error.
  if (isError) return null;

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
        {isLoading && <p className="text-sm text-muted-foreground">Loading organisations…</p>}
        {orgs.map((org) => {
          const on = org.enabledModules?.includes("crm") ?? false;
          return (
            <div key={org.id} className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{org.name}</p>
                <p className="text-xs text-muted-foreground">{org.slug}</p>
              </div>
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
          );
        })}
      </CardContent>
    </Card>
  );
}
