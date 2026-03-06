"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { useTickets, useRegistrationTypes } from "@/hooks/use-api";

interface RegistrationTypeSelectProps {
  value: string | null | undefined;
  onChange: (registrationType: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** When provided, fetches registration types from this event */
  eventId?: string;
}

export function RegistrationTypeSelect({
  value,
  onChange,
  disabled = false,
  placeholder = "Select registration type",
  eventId,
}: RegistrationTypeSelectProps) {
  const { data: tickets = [] } = useTickets(eventId || "");
  const { data: orgTypes = [] } = useRegistrationTypes();

  // Use event-specific ticket types if eventId provided, otherwise all org types
  const options: string[] = eventId
    ? tickets.map((t: { name: string }) => t.name)
    : orgTypes;

  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
