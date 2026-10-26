"use client";

import { SearchableSelect } from "./searchable-select";

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
  /** Put on the button you tap, so a <label htmlFor> can point at the picker. */
  id?: string;
  value: string | null | undefined;
  onChange: (specialty: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function SpecialtySelect({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "Select specialty",
}: SpecialtySelectProps) {
  return (
    <SearchableSelect
      id={id}
      value={value}
      onChange={onChange}
      options={SPECIALTIES.map((s) => ({ value: s, label: s }))}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder="Search specialties..."
      emptyText="No specialties found"
    />
  );
}
