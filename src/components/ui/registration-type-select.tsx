"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Input } from "./input";
import { useTickets } from "@/hooks/use-api";

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
  // If eventId is provided, fetch ticket types for the dropdown
  const { data: tickets = [] } = useTickets(eventId || "");

  // If no event context or no tickets, fall back to a plain text input
  if (!eventId || tickets.length === 0) {
    return (
      <Input
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Registration type"
      />
    );
  }

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {tickets.map((ticket: { id: string; name: string }) => (
          <SelectItem key={ticket.id} value={ticket.name}>
            {ticket.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
