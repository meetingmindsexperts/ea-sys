"use client";

/**
 * Sections the public registration form and the completion form share (docs/ONSITE_DESK_PLAN.md §3.3):
 * the billing details and the per-type supporting document. One copy, so the two forms ask for the same
 * things the same way. Moved out of src/app/e/[slug]/register/[category]/page.tsx unchanged.
 */
import { useState } from "react";
import type { Control, FieldValues, Path } from "react-hook-form";
import { CheckCircle2, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CountrySelect } from "@/components/ui/country-select";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SUPPORTING_DOCUMENT_ACCEPT, SUPPORTING_DOCUMENT_MAX_SIZE } from "@/lib/supporting-document";

// ── Billing ────────────────────────────────────────────────────────────────

/** The billing fields both forms carry. */
export interface BillingFieldValues {
  taxNumber?: string;
  billingFirstName?: string;
  billingLastName?: string;
  billingEmail?: string;
  billingPhone?: string;
  billingAddress?: string;
  billingCity?: string;
  billingState?: string;
  billingZipCode?: string;
  billingCountry?: string;
}

/** Required when billing is not the same as the personal details. */
export const BILLING_REQUIRED_FIELDS: { field: keyof BillingFieldValues; label: string }[] = [
  { field: "billingFirstName", label: "Billing first name" },
  { field: "billingLastName", label: "Billing last name" },
  { field: "billingEmail", label: "Billing email" },
  { field: "billingPhone", label: "Billing phone" },
  { field: "billingAddress", label: "Billing address" },
  { field: "billingCity", label: "Billing city" },
  { field: "billingState", label: "Billing state" },
  { field: "billingZipCode", label: "Billing zip code" },
  { field: "billingCountry", label: "Billing country" },
];

/** The required billing fields left blank, for the form to flag. */
export function missingBillingFields(values: BillingFieldValues): { field: keyof BillingFieldValues; label: string }[] {
  return BILLING_REQUIRED_FIELDS.filter(({ field }) => !values[field]?.toString().trim());
}

/** "Same as personal details": the personal values copied into the billing fields. */
export function billingFromPersonal(p: {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}): Partial<BillingFieldValues> {
  return {
    billingFirstName: p.firstName,
    billingLastName: p.lastName,
    billingEmail: p.email,
    billingPhone: p.phone,
    billingCity: p.city,
    billingState: p.state,
    billingZipCode: p.zipCode,
    billingCountry: p.country,
  };
}

const FIELD_LABEL = "text-sm font-medium text-slate-600";
const FIELD_INPUT = "rounded-lg border-slate-200 text-base";
const REQUIRED = <span className="text-red-400">*</span>;

function BillingInput<T extends FieldValues>(props: {
  control: Control<T>;
  name: keyof BillingFieldValues;
  label: string;
  required?: boolean;
  type?: string;
  autoComplete: string;
  placeholder: string;
}) {
  return (
    <FormField
      control={props.control}
      name={props.name as Path<T>}
      render={({ field }) => (
        <FormItem>
          <FormLabel className={FIELD_LABEL}>
            {props.label} {props.required && REQUIRED}
          </FormLabel>
          <FormControl>
            <Input type={props.type} autoComplete={props.autoComplete} placeholder={props.placeholder} className={FIELD_INPUT} {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** The Billing Details section: "same as personal details", else the tax number and billing address. */
export function BillingDetailsSection<T extends FieldValues>({
  control,
  billingSame,
  onBillingSameChange,
}: {
  control: Control<T>;
  billingSame: boolean;
  onBillingSameChange: (same: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">Billing Details</h3>

      <label className="flex items-center gap-3 cursor-pointer">
        <Checkbox checked={billingSame} onCheckedChange={(checked) => onBillingSameChange(!!checked)} />
        <span className="text-sm text-slate-600">Billing address same as personal details</span>
      </label>

      {!billingSame && (
        <div className="space-y-4 pt-1">
          <BillingInput control={control} name="taxNumber" label="Tax Number / VAT ID" autoComplete="off" placeholder="e.g. AE1234567890" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <BillingInput control={control} name="billingFirstName" label="First Name" required autoComplete="billing given-name" placeholder="Billing first name" />
            <BillingInput control={control} name="billingLastName" label="Last Name" required autoComplete="billing family-name" placeholder="Billing last name" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <BillingInput control={control} name="billingEmail" label="Email" required type="email" autoComplete="billing email" placeholder="billing@company.com" />
            <BillingInput control={control} name="billingPhone" label="Phone" required type="tel" autoComplete="billing tel" placeholder="+971..." />
          </div>
          <BillingInput control={control} name="billingAddress" label="Address" required autoComplete="billing street-address" placeholder="Street address" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField
              control={control}
              name={"billingCountry" as Path<T>}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={FIELD_LABEL}>Country {REQUIRED}</FormLabel>
                  <FormControl>
                    <CountrySelect value={field.value ?? ""} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <BillingInput control={control} name="billingCity" label="City" required autoComplete="billing address-level2" placeholder="City" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <BillingInput control={control} name="billingState" label="State / Province" required autoComplete="billing address-level1" placeholder="State" />
            <BillingInput control={control} name="billingZipCode" label="Zip / Postal Code" required autoComplete="billing postal-code" placeholder="00000" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Supporting document ─────────────────────────────────────────────────────

export interface UploadedDocument {
  url: string;
  filename: string;
}

/**
 * The supporting-document section, rendered from the type's own policy: the organiser's label and
 * instructions, required or not. Uploads to the event's public upload route, or to `uploadUrl` (the
 * onsite desk's staff route); the server re-checks size, type and content and is the authority.
 */
export function SupportingDocumentField({
  slug,
  uploadUrl,
  label,
  required,
  instructions,
  value,
  onChange,
  error,
  onError,
  onBeforeUpload,
}: {
  slug: string;
  /** Overrides the public upload route (the desk uploads through its own staff route). */
  uploadUrl?: string;
  label: string;
  required: boolean;
  instructions: string | null;
  value: UploadedDocument | null;
  onChange: (doc: UploadedDocument | null) => void;
  error: string | null;
  onError: (message: string | null) => void;
  /** Called as an upload starts (the public form clears its submit notice). */
  onBeforeUpload?: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear the input at once so picking the SAME file again after an error still fires a change.
    e.target.value = "";
    if (!file) return;
    onError(null);
    onBeforeUpload?.();
    // Checked here only to fail fast with a clear message.
    if (file.size > SUPPORTING_DOCUMENT_MAX_SIZE) {
      onError("The file must be under 5MB.");
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(uploadUrl ?? `/api/public/events/${slug}/supporting-document`, { method: "POST", body });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        onError(json?.error || "Could not upload the file. Please try again.");
        return;
      }
      onChange({ url: json.url, filename: json.filename });
    } catch (err) {
      console.error("supporting document upload failed", err);
      onError("Could not upload the file. Please check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3 mb-1">
        {label} {required && REQUIRED}
      </h3>
      {(instructions || !required) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          {instructions && (
            // Organiser-authored plain text, rendered as text, never HTML.
            <p className="text-sm text-amber-800 whitespace-pre-line">{instructions}</p>
          )}
          {!required && (
            <p className="mt-2 text-sm text-amber-700">
              You can complete your registration without it, but we will need it before the event.
            </p>
          )}
        </div>
      )}

      {value ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="truncate text-sm text-emerald-900" title={value.filename}>
              {value.filename}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 rounded-lg"
            onClick={() => {
              onChange(null);
              onError(null);
            }}
          >
            Replace
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <label
            htmlFor="supportingDocFile"
            className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-600 transition hover:border-primary/50 hover:bg-slate-100"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" /> Choose a file (PDF, JPG or PNG, up to 5MB)
              </>
            )}
          </label>
          <input
            id="supportingDocFile"
            type="file"
            className="sr-only"
            accept={SUPPORTING_DOCUMENT_ACCEPT}
            disabled={uploading}
            onChange={handleChange}
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-500" data-form-error="Supporting document">
          {error}
        </p>
      )}
    </div>
  );
}
