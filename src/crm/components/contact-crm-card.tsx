"use client";

/**
 * CRM block for the (core) contact detail sheet: which Account this person belongs
 * to, and where they sit in the lifecycle.
 *
 * This component is CRM-owned and mounted into a core sheet — the fourth permitted
 * core-side touch point (see docs/CRM_MODULE_PLAN.md §7.0 and the exemption list in
 * eslint.config.mjs). It is a component rather than fields inlined into the sheet
 * precisely so the coupling is ONE import at ONE mount point, and the labels,
 * colours and company-picker logic stay inside the module. Inlining them would have
 * meant duplicating LIFECYCLE_LABELS into core — i.e. drift by design.
 *
 * `Contact.organization` (free text) is deliberately kept alongside `companyId`: the
 * string is the raw captured value, the link is the curated one. We show the string
 * when there is no link, so it never looks like the data vanished.
 */
import { Building2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmCompanies } from "@/crm/hooks/use-crm-api";
import { canViewCrm, canOwnDeals } from "@/crm/lib/crm-roles";
import {
  LIFECYCLE_COLORS,
  LIFECYCLE_LABELS,
  type CrmLifecycleStage,
} from "@/crm/lib/crm-types";

const NONE = "__none__";

export function ContactCrmCard({
  role,
  companyId,
  organization,
  lifecycleStage,
  onChange,
  saving,
}: {
  role?: string | null;
  companyId?: string | null;
  /** The free-text Contact.organization — shown when there's no curated link yet. */
  organization?: string | null;
  lifecycleStage?: CrmLifecycleStage | null;
  onChange: (patch: { companyId?: string | null; lifecycleStage?: CrmLifecycleStage | null }) => void;
  saving?: boolean;
}) {
  const canRead = canViewCrm(role);
  const canWrite = canOwnDeals(role);

  const { data: companies = [], isLoading } = useCrmCompanies();

  // ONSITE / REVIEWER / SUBMITTER / REGISTRANT never see the CRM at all — including
  // this block on a contact they can otherwise reach.
  if (!canRead) return null;

  const linked = companies.find((c) => c.id === companyId);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          CRM
        </p>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Company</Label>
          {canWrite ? (
            <Select
              value={companyId ?? NONE}
              onValueChange={(v) => onChange({ companyId: v === NONE ? null : v })}
              disabled={isLoading}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Not linked" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not linked</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm">{linked?.name ?? <span className="text-muted-foreground">—</span>}</p>
          )}

          {/* The raw string still exists — show it so it never looks like data was lost. */}
          {!companyId && organization && (
            <p className="text-xs text-muted-foreground">
              Typed as “{organization}” — link it to an account above.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Lifecycle</Label>
          {canWrite ? (
            <Select
              value={lifecycleStage ?? NONE}
              onValueChange={(v) =>
                onChange({ lifecycleStage: v === NONE ? null : (v as CrmLifecycleStage) })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>—</SelectItem>
                {(Object.keys(LIFECYCLE_LABELS) as CrmLifecycleStage[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {LIFECYCLE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : lifecycleStage ? (
            <Badge variant="outline" className={LIFECYCLE_COLORS[lifecycleStage]}>
              {LIFECYCLE_LABELS[lifecycleStage]}
            </Badge>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Re-exported so the mounting core sheet doesn't need its own @/crm type import. */
export type { CrmLifecycleStage };
