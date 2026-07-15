"use client";

/**
 * "Sales rep" filter — the org's deal-owning staff.
 *
 * Sourced from the CRM-gated /api/crm/reps, which returns exactly the deal-owning
 * roles: the sales team (CRM_USER) and the admin tier (ADMIN / SUPER_ADMIN /
 * ORGANIZER). Using the dedicated endpoint (rather than the org-wide users API +
 * a client-side role filter) means a CRM_USER can populate the picker too, and the
 * list can never drift to include a MEMBER or reviewer.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCrmReps } from "@/crm/hooks/use-crm-api";

const ALL = "__all__";

export function OwnerFilter({
  value,
  onChange,
  placeholder = "All reps",
}: {
  value: string;
  onChange: (userId: string | null) => void;
  placeholder?: string;
}) {
  const { data: reps = [] } = useCrmReps();

  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="w-[12rem]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {reps.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.firstName} {u.lastName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
