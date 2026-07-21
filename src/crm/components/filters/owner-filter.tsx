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
  meId,
  meLabel = "Mine",
}: {
  value: string;
  onChange: (userId: string | null) => void;
  placeholder?: string;
  /** Pin the signed-in user to the top as a one-click "mine" entry. */
  meId?: string | null;
  meLabel?: string;
}) {
  const { data: reps = [] } = useCrmReps();
  // The pinned entry replaces my own row in the rep list — two items with the
  // same Select value would fight over highlighting.
  const others = meId ? reps.filter((u) => u.id !== meId) : reps;

  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="w-[12rem]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {meId && <SelectItem value={meId}>{meLabel}</SelectItem>}
        {others.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.firstName} {u.lastName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
