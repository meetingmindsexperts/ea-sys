"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { usePersonFields } from "@/hooks/use-person-fields";
import { storedAnswerLabel } from "@/lib/person-fields";

interface RoleSelectProps {
  /** Put on the button you tap, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string | null | undefined;
  onChange: (role: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * The Role picker every form uses (step 1c, part C2, of
 * docs/ORG_FIELDS_PLAN.md): the organisation's answers on offer, as this page's
 * event asks them (`usePersonFields`), never a fixed list. While they load, and
 * if they cannot be read, today's answers.
 *
 * A record being edited may hold an answer the form no longer offers (retired,
 * or from before the list changed). It is shown, as the record holds it, so the
 * form neither blanks it nor makes the person pick again; the doors keep a held
 * answer (`roleAnswerProblem`) and refuse only a newly chosen one.
 */
export function RoleSelect({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Select role",
}: RoleSelectProps) {
  const role = usePersonFields().role;
  const held = value && !role.answers.some((a) => a.key === value) ? value : null;
  return (
    // "" rather than undefined when empty: Radix Select (2.x) shows the
    // placeholder for "" and stays controlled, so picking a value no longer
    // logs "changing from uncontrolled to controlled".
    // An empty value from Radix is never a pick (no item has the value ""): it
    // is Radix's hidden native <select> missing a held answer whose item
    // renders one beat after a value set after mount, inside a <form>, and it
    // would blank the record's answer (review of 45b4ba3b, reproduced).
    <Select value={value || ""} onValueChange={(v) => { if (v) onChange(v); }} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {role.answers.map((r) => (
          <SelectItem key={r.key} value={r.key}>
            {r.label}
          </SelectItem>
        ))}
        {held && (
          <SelectItem key={held} value={held}>
            {storedAnswerLabel(role, held)} (no longer offered)
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
