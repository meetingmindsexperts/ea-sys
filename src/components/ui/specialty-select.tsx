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
import { Search } from "lucide-react";

export const SPECIALTIES = [
  "Anesthesia & Pain Medicine",
  "Cardiology",
  "Clinical Simulation",
  "Critical Care",
  "Dental",
  "Dermatology",
  "Diabetes",
  "Emergency Medicine",
  "Endocrinology",
  "Endoscopy",
  "Family Medicine",
  "Gastroenterology",
  "General Practice",
  "Genetics",
  "Health Economics",
  "Hematology",
  "Hepatology",
  "Immunology",
  "Infectious Disease",
  "Internal Medicine",
  "Laboratory",
  "Medical Education",
  "Nephrology",
  "Neurology",
  "Nursing",
  "Obstetrics & Gynecology",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Otolaryngology",
  "Parenteral Nutrition",
  "Pathology",
  "Pediatrics",
  "Pediatric Rehabilitation",
  "Pharmacy",
  "Preventative Medicine",
  "Psychiatry",
  "Public Health",
  "Radiology",
  "Rheumatology",
  "Respiratory Medicine",
  "Surgery",
  "Thalassemia",
  "Urology",
  "Others",
];

interface SpecialtySelectProps {
  value: string | null | undefined;
  onChange: (specialty: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function SpecialtySelect({
  value,
  onChange,
  disabled = false,
  placeholder = "Select specialty",
}: SpecialtySelectProps) {
  const [searchTerm, setSearchTerm] = useState("");

  const filtered = SPECIALTIES.filter((s) =>
    s.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder}>{value || undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <div className="flex items-center gap-2 px-2 pb-2 sticky top-0 bg-popover">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search specialties..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-8"
          />
        </div>
        <div className="max-h-[200px] overflow-y-auto">
          {filtered.length > 0 ? (
            filtered.map((specialty) => (
              <SelectItem key={specialty} value={specialty}>
                {specialty}
              </SelectItem>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              No specialties found
            </div>
          )}
        </div>
      </SelectContent>
    </Select>
  );
}
