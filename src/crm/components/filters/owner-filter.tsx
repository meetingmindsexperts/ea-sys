"use client";

/**
 * "Sales rep" filter — the org's deal-owning staff.
 *
 * Only staff (SUPER_ADMIN/ADMIN/ORGANIZER) can own a deal, so the picker is
 * filtered to those roles — a MEMBER or a reviewer in the user list would never
 * appear as an owner and would just be noise.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useOrgUsers } from "@/hooks/use-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";

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
  const { data: users = [] } = useOrgUsers();
  const reps = users.filter((u) => canOwnDeals(u.role));

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
