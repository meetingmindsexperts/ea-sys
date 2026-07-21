"use client";

/**
 * Public speaker-reimbursement form — the web replacement for the paper
 * "Speaker / Faculty Reimbursement Form" (bank wire transfer request).
 *
 * One personalized token link per speaker. Sections mirror the paper form:
 *   A — event details (read-only, from the event record)
 *   B — speaker/faculty details (prefilled from the Speaker record)
 *   C — reimbursement type: claim lines with currency + amount, live totals
 *   D — bank transfer details
 *   E — required documents (passport + a receipt per claimed expense)
 *   F — declaration + typed-name signature
 *
 * The server (`/api/public/events/[slug]/reimbursement/[token]`) re-validates
 * everything, including the receipt rule; this page mirrors the checks for
 * friendly inline feedback. A submitted form is locked (organizers can
 * reopen it for corrections).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertCircle,
  Banknote,
  CalendarDays,
  Check,
  FileText,
  Loader2,
  MapPin,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EventBanner } from "@/components/public/event-banner";
import { CountrySelect } from "@/components/ui/country-select";
import {
  CLAIM_ITEMS,
  DOCUMENT_KINDS,
  REIMBURSEMENT_CURRENCIES,
  ROLE_AT_EVENT_OPTIONS,
  computeClaimTotals,
  documentKindLabel,
  missingDocumentKinds,
  reimbursementSubmitSchema,
  type BankDetails,
  type ClaimLine,
  type ReimbursementCurrency,
} from "@/lib/reimbursement/constants";
import { toast } from "sonner";

interface DocumentRow {
  id: string;
  kind: string;
  filename: string;
  size: number;
}
interface LoadedData {
  event: {
    slug: string;
    name: string;
    bannerImage: string | null;
    bannerImageMobile: string | null;
    startDate: string;
    endDate: string;
    timezone: string | null;
    eventType: string;
    venue: string | null;
    city: string | null;
    organizationName: string | null;
  };
  status: "PENDING" | "SUBMITTED";
  submittedAt: string | null;
  prefill: {
    fullName: string;
    designation: string;
    institution: string;
    country: string;
    email: string;
    phone: string;
    nationality: string;
    passportNumber: string;
    roleAtEvent: string;
    claimLines: ClaimLine[];
    bankDetails: (BankDetails & Record<string, string | null>) | null;
    signedName: string;
  };
  documents: DocumentRow[];
}

interface ClaimDraft {
  enabled: boolean;
  currency: ReimbursementCurrency;
  amount: string;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  CONFERENCE: "In-person Conference",
  WEBINAR: "Virtual Webinar",
  HYBRID: "Hybrid Event",
};

const EMPTY_BANK = {
  beneficiaryName: "",
  beneficiaryAddress: "",
  bankName: "",
  bankAddress: "",
  bankCountry: "",
  accountNumber: "",
  iban: "",
  swift: "",
  routingNumber: "",
  sortCode: "",
  intermediaryBank: "",
};

function fmtDateRange(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  const start = new Date(startIso).toLocaleDateString("en-GB", opts);
  const end = new Date(endIso).toLocaleDateString("en-GB", opts);
  return start === end ? start : `${start} – ${end}`;
}

export default function ReimbursementFormPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const [data, setData] = useState<LoadedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Section B
  const [fields, setFields] = useState({
    fullName: "",
    designation: "",
    institution: "",
    country: "",
    email: "",
    phone: "",
    nationality: "",
    passportNumber: "",
  });
  const [rolePick, setRolePick] = useState("");
  const [roleOther, setRoleOther] = useState("");

  // Section C — one draft per claim item
  const [claims, setClaims] = useState<Record<string, ClaimDraft>>(() =>
    Object.fromEntries(
      CLAIM_ITEMS.map((c) => [c.key, { enabled: false, currency: "USD" as const, amount: "" }]),
    ),
  );

  // Section D
  const [bank, setBank] = useState({ ...EMPTY_BANK });

  // Section E
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [uploadingKind, setUploadingKind] = useState<string | null>(null);

  // Section F
  const [signedName, setSignedName] = useState("");
  const [declaration, setDeclaration] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/events/${slug}/reimbursement/${token}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          console.error("reimbursement-form:load-failed", res.status, json?.error);
          setLoadError(json.error || "This reimbursement link is invalid.");
          return;
        }
        const loaded = json as LoadedData;
        setData(loaded);
        setDocuments(loaded.documents);
        const p = loaded.prefill;
        setFields({
          fullName: p.fullName,
          designation: p.designation,
          institution: p.institution,
          country: p.country,
          email: p.email,
          phone: p.phone,
          nationality: p.nationality,
          passportNumber: p.passportNumber,
        });
        if (p.roleAtEvent) {
          if ((ROLE_AT_EVENT_OPTIONS as readonly string[]).includes(p.roleAtEvent)) {
            setRolePick(p.roleAtEvent);
          } else {
            setRolePick("Other");
            setRoleOther(p.roleAtEvent);
          }
        }
        if (p.claimLines?.length) {
          setClaims((prev) => {
            const next = { ...prev };
            for (const line of p.claimLines) {
              next[line.item] = {
                enabled: true,
                currency: line.currency,
                amount: String(line.amount),
              };
            }
            return next;
          });
        }
        if (p.bankDetails) {
          setBank((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(EMPTY_BANK) as (keyof typeof EMPTY_BANK)[]) {
              const v = p.bankDetails?.[key];
              if (typeof v === "string") next[key] = v;
            }
            return next;
          });
        }
        if (p.signedName) setSignedName(p.signedName);
      } catch (err) {
        console.error("reimbursement-form:load-error", err);
        if (!cancelled) setLoadError("Couldn't load the form. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  const claimLines = useMemo<ClaimLine[]>(
    () =>
      CLAIM_ITEMS.filter((c) => claims[c.key]?.enabled)
        .map((c) => {
          const draft = claims[c.key];
          const amount = Number.parseFloat(draft.amount);
          return Number.isFinite(amount) && amount > 0
            ? { item: c.key, currency: draft.currency, amount: Math.round(amount * 100) / 100 }
            : null;
        })
        .filter((l): l is ClaimLine => l !== null),
    [claims],
  );
  const totals = useMemo(() => computeClaimTotals(claimLines), [claimLines]);
  const missingDocs = useMemo(
    () => missingDocumentKinds(claimLines, documents.map((d) => d.kind)),
    [claimLines, documents],
  );

  const handleUpload = useCallback(
    async (kind: string, file: File) => {
      setUploadingKind(kind);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("kind", kind);
        const res = await fetch(`/api/public/events/${slug}/reimbursement/${token}/documents`, {
          method: "POST",
          body: formData,
        });
        const json = await res.json();
        if (!res.ok) {
          console.error("reimbursement-form:upload-failed", res.status, json?.error);
          toast.error(json?.error || "Upload failed");
          return;
        }
        setDocuments((prev) => [...prev, json.document]);
        toast.success("Uploaded");
      } catch (err) {
        console.error("reimbursement-form:upload-error", err);
        toast.error("Upload failed. Please try again.");
      } finally {
        setUploadingKind(null);
      }
    },
    [slug, token],
  );

  const handleRemoveDoc = useCallback(
    async (doc: DocumentRow) => {
      try {
        const res = await fetch(
          `/api/public/events/${slug}/reimbursement/${token}/documents/${doc.id}`,
          { method: "DELETE" },
        );
        const json = await res.json();
        if (!res.ok) {
          console.error("reimbursement-form:doc-delete-failed", res.status, json?.error);
          toast.error(json?.error || "Couldn't remove the file");
          return;
        }
        setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      } catch (err) {
        console.error("reimbursement-form:doc-delete-error", err);
        toast.error("Couldn't remove the file");
      }
    },
    [slug, token],
  );

  const handleSubmit = useCallback(async () => {
    setFieldErrors({});
    const roleAtEvent = rolePick === "Other" ? roleOther.trim() : rolePick;
    const payload = {
      ...fields,
      roleAtEvent,
      claimLines,
      bankDetails: bank,
      signedName: signedName.trim(),
      declarationAccepted: declaration as true,
    };
    const parsed = reimbursementSubmitSchema.safeParse(payload);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const errors: Record<string, string> = {};
      for (const [key, msgs] of Object.entries(flat.fieldErrors)) {
        if (msgs?.[0]) errors[key] = msgs[0];
      }
      setFieldErrors(errors);
      toast.error("Please complete the highlighted fields.");
      return;
    }
    if (missingDocs.length > 0) {
      toast.error(
        `Please upload: ${missingDocs.map((k) => documentKindLabel(k)).join(", ")}`,
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/events/${slug}/reimbursement/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const json = await res.json();
      if (!res.ok) {
        console.error("reimbursement-form:submit-failed", res.status, json?.error, json?.code);
        if (json?.code === "MISSING_DOCUMENTS" && Array.isArray(json.missing)) {
          toast.error(
            `Please upload: ${json.missing.map((k: string) => documentKindLabel(k)).join(", ")}`,
          );
        } else {
          toast.error(json?.error || "Failed to submit the form.");
        }
        return;
      }
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error("reimbursement-form:submit-error", err);
      toast.error("Failed to submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [fields, rolePick, roleOther, claimLines, bank, signedName, declaration, missingDocs, slug, token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (loadError || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="h-10 w-10 mx-auto mb-3 text-destructive" />
          <p className="font-medium">{loadError || "This reimbursement link is invalid."}</p>
        </div>
      </div>
    );
  }

  const alreadySubmitted = data.status === "SUBMITTED" && !done;
  const setField = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((prev) => ({ ...prev, [key]: e.target.value }));
  const setBankField = (key: keyof typeof EMPTY_BANK) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setBank((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="min-h-screen bg-slate-100 pb-16 [color-scheme:light]">
      {/* Same constrained banner band as the other public pages (register):
          natural aspect, capped width — a wide banner never stretches
          edge-to-edge on large screens. */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-[1120px] mx-auto">
          <EventBanner
            banner={data.event.bannerImage}
            bannerMobile={data.event.bannerImageMobile}
            name={data.event.name}
            className="block w-full h-auto"
            priority
          />
        </div>
        <div className="h-1 bg-gradient-primary" />
      </div>
      <div className="max-w-4xl mx-auto px-4">
        {/* Elevated document card: layered shadow + hairline ring so the
            form reads as a signed financial document, not a flat panel. */}
        <div className="bg-white rounded-2xl mt-8 overflow-hidden ring-1 ring-slate-900/10 shadow-[0_1px_2px_rgb(15_23_42/0.06),0_12px_24px_-8px_rgb(15_23_42/0.10),0_32px_64px_-16px_rgb(15_23_42/0.14)]">
          <div className="px-6 sm:px-10 pt-8 pb-6 border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary mb-1.5">
              Bank wire transfer request
              {data.event.organizationName ? ` · ${data.event.organizationName}` : ""}
            </p>
            <h1 className="text-2xl sm:text-[28px] font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
                <Banknote className="h-5 w-5" />
              </span>
              Speaker / Faculty Reimbursement Form
            </h1>
          </div>

          <div className="p-6 sm:p-10">
          {done || alreadySubmitted ? (
            <div className="text-center py-10">
              <div className="mx-auto w-16 h-16 rounded-full bg-emerald-100 ring-8 ring-emerald-50 flex items-center justify-center mb-5">
                <Check className="h-8 w-8 text-emerald-600" />
              </div>
              <h2 className="text-xl font-semibold text-slate-900 mb-2">
                {done ? "Form submitted — thank you!" : "This form has already been submitted."}
              </h2>
              <p className="text-slate-600 max-w-md mx-auto">
                {done
                  ? "We've emailed you a confirmation. Payment will be processed by bank wire transfer within 45 days of receipt of the completed form and all supporting documents."
                  : "If you need to correct your details, please contact the organizing team — they can reopen the form for you."}
              </p>

              {/* Append-only documents after submission (owner decision,
                  July 21 2026): a forgotten or illegible receipt can be
                  added without a reopen. Details stay locked; files can't
                  be removed by the speaker once the form is signed. */}
              <div className="mt-10 text-left border-t border-slate-200 pt-8">
                <h3 className="text-sm font-bold uppercase tracking-wide text-slate-900 mb-1.5">
                  Add more documents
                </h3>
                <p className="text-sm text-slate-600 mb-4">
                  Forgot a receipt, or asked for a clearer copy? You can still add documents here
                  — your submitted details stay unchanged. Added files can&apos;t be removed;
                  contact the organizing team if something needs to come off.
                </p>
                <div className="space-y-2">
                  {DOCUMENT_KINDS.map((dk) => {
                    const docsOfKind = documents.filter((d) => d.kind === dk.key);
                    const uploading = uploadingKind === dk.key;
                    return (
                      <div
                        key={dk.key}
                        className={`rounded-lg px-3.5 py-3 ${
                          docsOfKind.length > 0
                            ? "border border-emerald-300 bg-emerald-50/50"
                            : "border-[1.5px] border-dashed border-slate-300"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-800 flex items-center gap-2">
                            {docsOfKind.length > 0 && (
                              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white">
                                <Check className="h-3 w-3" />
                              </span>
                            )}
                            {dk.label}
                          </span>
                          <label className="cursor-pointer">
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:border-primary/60 hover:text-primary transition-colors">
                              {uploading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Upload className="h-4 w-4" />
                              )}
                              Upload
                            </span>
                            <input
                              type="file"
                              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                              className="hidden"
                              disabled={uploading}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void handleUpload(dk.key, file);
                                e.target.value = "";
                              }}
                            />
                          </label>
                        </div>
                        {docsOfKind.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {docsOfKind.map((doc) => (
                              <li
                                key={doc.id}
                                className="flex items-center gap-1.5 text-sm text-slate-600 truncate"
                              >
                                <FileText className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{doc.filename}</span>
                                <span className="text-xs shrink-0">
                                  {(doc.size / 1024).toFixed(0)} KB
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-12 [&_input]:border-slate-300 [&_input]:bg-white [&_textarea]:border-slate-300 [&_select]:border-slate-300">
              {/* Section A */}
              <section>
                <SectionHeading letter="A" title="Event Details" />
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3">
                    <CalendarDays className="h-4 w-4 mt-0.5 text-primary" />
                    <div>
                      <div className="font-semibold text-slate-900">{data.event.name}</div>
                      <div className="text-slate-600">
                        {fmtDateRange(data.event.startDate, data.event.endDate)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3">
                    <MapPin className="h-4 w-4 mt-0.5 text-primary" />
                    <div>
                      <div className="font-semibold text-slate-900">
                        {EVENT_TYPE_LABELS[data.event.eventType] ?? data.event.eventType}
                      </div>
                      <div className="text-slate-600">
                        {[data.event.venue, data.event.city].filter(Boolean).join(", ") || "—"}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Section B */}
              <section>
                <SectionHeading letter="B" title="Speaker / Faculty Details" />
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Full name (as on passport)" required error={fieldErrors.fullName}>
                    <Input value={fields.fullName} onChange={setField("fullName")} />
                  </Field>
                  <Field label="Title / Designation" error={fieldErrors.designation}>
                    <Input value={fields.designation} onChange={setField("designation")} />
                  </Field>
                  <Field label="Institution / Hospital / Affiliation" error={fieldErrors.institution}>
                    <Input value={fields.institution} onChange={setField("institution")} />
                  </Field>
                  <Field label="Country" required error={fieldErrors.country}>
                    <CountrySelect
                      value={fields.country}
                      onChange={(v) => setFields((prev) => ({ ...prev, country: v }))}
                    />
                  </Field>
                  <Field label="Email address" required error={fieldErrors.email}>
                    <Input type="email" value={fields.email} onChange={setField("email")} />
                  </Field>
                  <Field label="Mobile / WhatsApp number" error={fieldErrors.phone}>
                    <Input value={fields.phone} onChange={setField("phone")} />
                  </Field>
                  <Field label="Nationality" required error={fieldErrors.nationality}>
                    <CountrySelect
                      value={fields.nationality}
                      onChange={(v) => setFields((prev) => ({ ...prev, nationality: v }))}
                      placeholder="Select nationality"
                    />
                  </Field>
                  <Field label="Passport number" required error={fieldErrors.passportNumber}>
                    <Input value={fields.passportNumber} onChange={setField("passportNumber")} />
                  </Field>
                </div>
                <div className="mt-4">
                  <Label className="mb-2 block">
                    Role at event <span className="text-destructive">*</span>
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    {[...ROLE_AT_EVENT_OPTIONS, "Other"].map((opt) => (
                      <Button
                        key={opt}
                        type="button"
                        size="sm"
                        variant={rolePick === opt ? "default" : "outline"}
                        onClick={() => setRolePick(opt)}
                      >
                        {opt}
                      </Button>
                    ))}
                  </div>
                  {rolePick === "Other" && (
                    <Input
                      className="mt-2 max-w-xs"
                      placeholder="Please specify"
                      value={roleOther}
                      onChange={(e) => setRoleOther(e.target.value)}
                    />
                  )}
                  {fieldErrors.roleAtEvent && (
                    <p className="text-xs text-destructive mt-1">Please choose your role.</p>
                  )}
                </div>
              </section>

              {/* Section C */}
              <section>
                <SectionHeading letter="C" title="Reimbursement Type" />
                <p className="text-sm text-slate-600 mb-3">
                  Select all that apply and enter the amount for each.
                </p>
                <div className="space-y-2">
                  {CLAIM_ITEMS.map((item) => {
                    const draft = claims[item.key];
                    return (
                      <div
                        key={item.key}
                        className={`flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors ${
                          draft.enabled
                            ? "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/20"
                            : "border-slate-200 hover:border-slate-300 hover:bg-slate-50/60"
                        }`}
                      >
                        <label className="flex items-center gap-2.5 flex-1 min-w-40 cursor-pointer">
                          <Checkbox
                            checked={draft.enabled}
                            onCheckedChange={(v) =>
                              setClaims((prev) => ({
                                ...prev,
                                [item.key]: { ...prev[item.key], enabled: Boolean(v) },
                              }))
                            }
                          />
                          <span className="text-sm font-medium text-slate-800">{item.label}</span>
                        </label>
                        {draft.enabled && (
                          <div className="flex items-center gap-2">
                            <select
                              className="h-9 rounded-md border bg-background px-2 text-sm"
                              value={draft.currency}
                              onChange={(e) =>
                                setClaims((prev) => ({
                                  ...prev,
                                  [item.key]: {
                                    ...prev[item.key],
                                    currency: e.target.value as ReimbursementCurrency,
                                  },
                                }))
                              }
                            >
                              {REIMBURSEMENT_CURRENCIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="Amount"
                              className="w-32"
                              value={draft.amount}
                              onChange={(e) =>
                                setClaims((prev) => ({
                                  ...prev,
                                  [item.key]: { ...prev[item.key], amount: e.target.value },
                                }))
                              }
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between items-center mt-3 px-4 py-3 bg-slate-900 text-white rounded-lg shadow-sm">
                  <span className="text-sm font-semibold uppercase tracking-wide">Total</span>
                  <span className="text-base font-bold tabular-nums">
                    {claimLines.length
                      ? REIMBURSEMENT_CURRENCIES.filter((c) => totals[c] != null)
                          .map(
                            (c) =>
                              `${c} ${totals[c]!.toLocaleString("en-US", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}`,
                          )
                          .join(" · ")
                      : "—"}
                  </span>
                </div>
                {fieldErrors.claimLines && (
                  <p className="text-xs text-destructive mt-1">
                    Select at least one item and enter its amount.
                  </p>
                )}
              </section>

              {/* Section D */}
              <section>
                <SectionHeading letter="D" title="Bank Transfer Details" />
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field
                    label="Beneficiary name (full legal name of account holder)"
                    required
                    error={fieldErrors.bankDetails && undefined}
                  >
                    <Input value={bank.beneficiaryName} onChange={setBankField("beneficiaryName")} />
                  </Field>
                  <Field label="Beneficiary address">
                    <Input value={bank.beneficiaryAddress} onChange={setBankField("beneficiaryAddress")} />
                  </Field>
                  <Field label="Bank name" required>
                    <Input value={bank.bankName} onChange={setBankField("bankName")} />
                  </Field>
                  <Field label="Bank address">
                    <Input value={bank.bankAddress} onChange={setBankField("bankAddress")} />
                  </Field>
                  <Field label="Bank country">
                    <CountrySelect
                      value={bank.bankCountry}
                      onChange={(v) => setBank((prev) => ({ ...prev, bankCountry: v }))}
                      placeholder="Select bank country"
                    />
                  </Field>
                  <Field label="Account number (or provide IBAN)">
                    <Input value={bank.accountNumber} onChange={setBankField("accountNumber")} />
                  </Field>
                  <Field label="IBAN (if applicable)">
                    <Input value={bank.iban} onChange={setBankField("iban")} />
                  </Field>
                  <Field label="SWIFT / BIC code" required>
                    <Input value={bank.swift} onChange={setBankField("swift")} />
                  </Field>
                  <Field label="Routing number (US / USD accounts)">
                    <Input value={bank.routingNumber} onChange={setBankField("routingNumber")} />
                  </Field>
                  <Field label="SORT code (UK accounts)">
                    <Input value={bank.sortCode} onChange={setBankField("sortCode")} />
                  </Field>
                  <Field label="Intermediary bank (if any)">
                    <Input value={bank.intermediaryBank} onChange={setBankField("intermediaryBank")} />
                  </Field>
                </div>
                {fieldErrors.bankDetails && (
                  <p className="text-xs text-destructive mt-2">
                    Please complete the required bank fields (beneficiary name, bank name,
                    SWIFT / BIC, and an account number or IBAN).
                  </p>
                )}
              </section>

              {/* Section E */}
              <section>
                <SectionHeading letter="E" title="Required Documents" />
                <p className="text-sm text-slate-600 mb-3">
                  PDF, JPG or PNG, up to 10MB each. A passport copy is always required, plus a
                  receipt for every expense you claim —{" "}
                  <strong>expenses without receipts cannot be processed.</strong>
                </p>
                <div className="space-y-2">
                  {DOCUMENT_KINDS.map((dk) => {
                    const docsOfKind = documents.filter((d) => d.kind === dk.key);
                    const required = missingDocs.includes(dk.key);
                    const uploading = uploadingKind === dk.key;
                    return (
                      <div
                        key={dk.key}
                        className={`rounded-lg px-3.5 py-3 transition-colors ${
                          docsOfKind.length > 0
                            ? "border border-emerald-300 bg-emerald-50/50"
                            : "border-[1.5px] border-dashed border-slate-300 hover:border-primary/50 hover:bg-slate-50/60"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-800 flex items-center gap-2">
                            {docsOfKind.length > 0 && (
                              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white">
                                <Check className="h-3 w-3" />
                              </span>
                            )}
                            {dk.label}
                            {required && (
                              <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[11px] font-semibold">
                                required
                              </span>
                            )}
                          </span>
                          <label className="cursor-pointer">
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:border-primary/60 hover:text-primary transition-colors">
                              {uploading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Upload className="h-4 w-4" />
                              )}
                              Upload
                            </span>
                            <input
                              type="file"
                              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                              className="hidden"
                              disabled={uploading}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void handleUpload(dk.key, file);
                                e.target.value = "";
                              }}
                            />
                          </label>
                        </div>
                        {docsOfKind.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {docsOfKind.map((doc) => (
                              <li
                                key={doc.id}
                                className="flex items-center justify-between text-sm text-slate-600"
                              >
                                <span className="flex items-center gap-1.5 truncate">
                                  <FileText className="h-3.5 w-3.5 shrink-0" />
                                  <span className="truncate">{doc.filename}</span>
                                  <span className="text-xs shrink-0">
                                    {(doc.size / 1024).toFixed(0)} KB
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  className="p-1 hover:text-destructive"
                                  title="Remove"
                                  onClick={() => void handleRemoveDoc(doc)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Section F */}
              <section>
                <SectionHeading letter="F" title="Declaration & Signature" />
                <div className="rounded-lg border border-amber-200 bg-amber-50/70 border-l-4 border-l-amber-400 p-4 text-sm leading-relaxed text-slate-700 mb-4">
                  I confirm that the information provided above is accurate and complete. I
                  understand that payment will be processed by bank wire transfer within{" "}
                  <strong className="text-slate-900">45 days</strong> of receipt of this completed
                  form and all required supporting documents.
                  {data.event.organizationName ? ` ${data.event.organizationName}` : " The organizer"}{" "}
                  is not responsible for bank charges or currency conversion fees.
                </div>
                <label
                  className={`flex items-start gap-2.5 cursor-pointer mb-5 rounded-lg border px-3.5 py-3 transition-colors ${
                    declaration
                      ? "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/20"
                      : "border-slate-200 hover:border-slate-300 hover:bg-slate-50/60"
                  }`}
                >
                  <Checkbox
                    checked={declaration}
                    onCheckedChange={(v) => setDeclaration(Boolean(v))}
                    className="mt-0.5"
                  />
                  <span className="text-sm font-medium text-slate-800">
                    I agree to the declaration above. <span className="text-destructive">*</span>
                  </span>
                </label>
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field
                    label="Type your full name as signature"
                    required
                    error={fieldErrors.signedName}
                  >
                    <Input
                      value={signedName}
                      onChange={(e) => setSignedName(e.target.value)}
                      placeholder="Your full name"
                    />
                  </Field>
                  <Field label="Date">
                    <Input value={new Date().toLocaleDateString("en-GB")} disabled />
                  </Field>
                </div>
              </section>

              <div>
                <Button
                  className="w-full h-12 text-base font-semibold btn-gradient shadow-lg shadow-primary/25 disabled:opacity-40 disabled:shadow-none"
                  size="lg"
                  disabled={submitting || !declaration}
                  onClick={() => void handleSubmit()}
                >
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Submit reimbursement form
                </Button>
                {!declaration && (
                  <p className="text-xs text-slate-500 mt-2 text-center">
                    Tick the declaration above to enable submission.
                  </p>
                )}
                {missingDocs.length > 0 && claimLines.length > 0 && (
                  <p className="text-xs font-medium text-amber-700 mt-2 text-center">
                    Still required: {missingDocs.map((k) => documentKindLabel(k)).join(", ")}
                  </p>
                )}
              </div>

              <p className="text-xs leading-relaxed text-slate-500 border-t border-slate-200 pt-5">
                Your details and documents are used for reimbursement processing only. See our{" "}
                <a
                  href="https://www.meetingmindsgroup.com/privacy-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  Privacy Policy
                </a>
                .
              </p>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ letter, title }: { letter: string; title: string }) {
  return (
    <h2 className="mb-5 flex items-center gap-3">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white text-[13px] font-bold shadow-sm">
        {letter}
      </span>
      <span className="text-[15px] font-bold uppercase tracking-wide text-slate-900">{title}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-slate-300 to-transparent" aria-hidden />
    </h2>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-[13px] font-medium text-slate-700">
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs font-medium text-destructive mt-1">{error}</p>}
    </div>
  );
}
