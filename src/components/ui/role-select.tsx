"use client";

import { useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { usePersonFieldsState } from "@/hooks/use-person-fields";
import { storedAnswerLabel } from "@/lib/person-fields";

interface RoleSelectProps {
  /** Put on the button you tap, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string | null | undefined;
  onChange: (role: string) => void;
  /**
   * The Role the RECORD being edited holds now, on an edit form. Only this
   * answer is shown when the organisation no longer offers it ("(no longer
   * offered)"), and it stays in the list if the person moves off it and back:
   * the doors keep a held answer and refuse only a newly chosen one. A create
   * form passes nothing.
   */
  held?: string | null;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * The Role picker every form uses (step 1c, part C2, and 1d of
 * docs/ORG_FIELDS_PLAN.md): the organisation's answers on offer, as this page's
 * event asks them (`usePersonFieldsState`), never a fixed list. While they
 * load, and if they cannot be read, today's answers.
 *
 * Once the organisation's REAL list is in, a value that is neither on offer
 * nor the record's held answer is dropped: a create form prefilled from an
 * account profile or a saved draft would otherwise submit an answer the door
 * refuses (review of 45b4ba3b). Nothing is judged against the list shown
 * while loading, which may not be the organisation's.
 */
export function RoleSelect({
  id,
  value,
  onChange,
  held,
  disabled = false,
  placeholder = "Select role",
}: RoleSelectProps) {
  const { fields, ready } = usePersonFieldsState();
  const role = fields.role;
  const offered = (key: string | null | undefined) => !!key && role.answers.some((a) => a.key === key);
  // The record's own answer, shown when it is no longer offered.
  const heldItem = ready && held && !offered(held) ? held : null;
  // Before the real list is in, a value the shown list lacks still shows as itself.
  const loadingItem = !ready && value && !offered(value) ? value : null;
  const stale = ready && !!value && !offered(value) && value !== held;

  useEffect(() => {
    if (stale) onChange("");
  }, [stale, onChange]);

  return (
    // "" rather than undefined when empty: Radix Select (2.x) shows the
    // placeholder for "" and stays controlled, so picking a value no longer
    // logs "changing from uncontrolled to controlled".
    // An empty value from Radix is never a pick (no item has the value ""): it
    // is Radix's hidden native <select> missing a held answer whose item
    // renders one beat after a value set after mount, inside a <form>, and it
    // would blank the record's answer (review of 45b4ba3b, reproduced).
    <Select value={stale ? "" : value || ""} onValueChange={(v) => { if (v) onChange(v); }} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {role.answers.map((r) => (
          <SelectItem key={r.key} value={r.key}>
            {r.label}
          </SelectItem>
        ))}
        {heldItem && (
          <SelectItem key={heldItem} value={heldItem}>
            {storedAnswerLabel(role, heldItem)} (no longer offered)
          </SelectItem>
        )}
        {loadingItem && loadingItem !== heldItem && (
          <SelectItem key={loadingItem} value={loadingItem}>
            {storedAnswerLabel(role, loadingItem)}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
