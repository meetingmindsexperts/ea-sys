"use client";

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Input } from "./input";
import { countries } from "@/lib/countries";
import { Search } from "lucide-react";

interface CountrySelectProps {
  value: string | null | undefined;
  onChange: (country: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function CountrySelect({
  value,
  onChange,
  disabled = false,
  placeholder = "Select country",
}: CountrySelectProps) {
  const [searchTerm, setSearchTerm] = useState("");

  const filteredCountries = countries.filter((country) =>
    country.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const selectedCountry = countries.find((c) => c.code === value || c.name === value);

  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder}>
          {selectedCountry?.name || value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <div className="flex items-center gap-2 px-2 pb-2 sticky top-0 bg-popover">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search countries..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-8"
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto">
          {filteredCountries.length > 0 ? (
            filteredCountries.map((country) => (
              <SelectItem key={country.code} value={country.name}>
                {country.name}
              </SelectItem>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              No countries found
            </div>
          )}
        </div>
      </SelectContent>
    </Select>
  );
}
