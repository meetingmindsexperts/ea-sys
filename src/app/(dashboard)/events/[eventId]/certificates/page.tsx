"use client";

/**
 * Certificates page — three tabs:
 *
 *   1. Template       — organizer-controlled visual config: banner image
 *                       upload, title text + color, body template with
 *                       merge tokens, signatures repeater (chairman +
 *                       co-chairmen), footer logos repeater (society
 *                       logos), footer text.
 *   2. CME / CPD      — per-event hours awarded + accrediting bodies
 *                       (DHA/EACCME/etc) for CME certs. Independent of
 *                       the template; tokens render conditionally.
 *   3. Preview        — render any of the four cert types as PDF in
 *                       an iframe with background fetch probe so server
 *                       errors are visible. SUPER_ADMIN design-approval
 *                       gate lives here (it's the cert-design sign-off
 *                       step, naturally adjacent to the preview).
 *
 * Phase C will add eligibility-list / Issue tabs above this once the
 * design-approval flag is flipped.
 */

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PhotoUpload } from "@/components/ui/photo-upload";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import dynamic from "next/dynamic";
import {
  GraduationCap,
  Plus,
  Trash2,
  Save,
  Eye,
  Info,
  Lock,
  CheckCircle2,
  Image as ImageIcon,
  FileText,
  PenLine,
  PaintBucket,
} from "lucide-react";

// Lazy-load Tiptap so the cert page doesn't pull the entire editor
// bundle into the dashboard's first-paint critical path. Matches the
// pattern used by other dashboard pages that embed Tiptap.
const TiptapEditor = dynamic(
  () => import("@/components/ui/tiptap-editor").then((m) => m.TiptapEditor),
  { ssr: false, loading: () => <div className="h-48 rounded border bg-muted/30 animate-pulse" /> },
);

type CertType = "ATTENDANCE" | "PRESENTER" | "POSTER" | "CME";

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;
type AccreditorBody = (typeof ACCREDITOR_BODIES)[number];

interface AccreditationRow {
  body: AccreditatorBodyOrEmpty;
  reference: string;
  hours?: number;
  officialStatement?: string;
}
type AccreditatorBodyOrEmpty = AccreditorBody | "";

interface SignatureRow {
  image?: string | null;
  name: string;
  lines: string[];
}

interface FooterLogoRow {
  label?: string;
  image: string;
}

interface TemplateState {
  headerImage: string | null;
  titleText: string;
  titleColor: string;
  bodyTemplate: string;
  signatures: SignatureRow[];
  footerLogos: FooterLogoRow[];
  footerText: string;
}

const CERT_TYPES = [
  { key: "ATTENDANCE", label: "Attendance" },
  { key: "PRESENTER", label: "Presenter / Faculty" },
  { key: "POSTER", label: "Poster Presenter" },
  { key: "CME", label: "CME" },
] as const;
type CertTypeKey = (typeof CERT_TYPES)[number]["key"];

type TemplatesByType = Record<CertTypeKey, TemplateState>;

interface SettingsResponse {
  cmeHours: number | null;
  accreditations: AccreditationRow[];
  designApprovedBy: string | null;
  designApprovedAt: string | null;
  templates: TemplatesByType;
}

const EMPTY_TEMPLATE: TemplateState = {
  headerImage: null,
  titleText: "",
  titleColor: "#1a2e5a",
  bodyTemplate: "",
  signatures: [],
  footerLogos: [],
  footerText: "",
};

function makeEmptyTemplates(): TemplatesByType {
  return {
    ATTENDANCE: { ...EMPTY_TEMPLATE },
    PRESENTER: { ...EMPTY_TEMPLATE },
    POSTER: { ...EMPTY_TEMPLATE },
    CME: { ...EMPTY_TEMPLATE },
  };
}

const AVAILABLE_TOKENS: Array<{ token: string; description: string }> = [
  { token: "{{recipientName}}", description: "Full attendee name (with title prefix)" },
  { token: "{{eventName}}", description: "Event name from the event record" },
  { token: "{{eventDateRange}}", description: "Event start–end dates (e.g. 5th - 7th December 2025)" },
  { token: "{{venueLine}}", description: "Venue + city + country, prefixed with 'at'" },
  { token: "{{accreditationBody}}", description: "First accreditor's friendly name (e.g. Dubai Health Authority (DHA))" },
  { token: "{{accreditationReference}}", description: "First accreditor's reference number" },
  { token: "{{cmeHours}}", description: "CME hours from the event's CME tab" },
];

export default function CertificatesPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const [draft, setDraft] = useState<SettingsResponse | null>(null);
  // Which cert type's template is currently being edited in the Template
  // tab — switched via the inner sub-tabs. State scope is page-level so
  // the selection survives switching between outer tabs (Template / CME /
  // Preview).
  const [activeTemplateType, setActiveTemplateType] = useState<CertTypeKey>("ATTENDANCE");
  const [previewType, setPreviewType] = useState<CertType>("ATTENDANCE");
  const [previewBust, setPreviewBust] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewProbe, setPreviewProbe] = useState<
    | { kind: "idle" }
    | { kind: "probing" }
    | { kind: "ok"; bytes: number }
    | { kind: "http-error"; status: number; body: string }
    | { kind: "network-error"; message: string }
  >({ kind: "idle" });

  const settingsQuery = useQuery<SettingsResponse>({
    queryKey: ["cert-settings", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/settings`);
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      const json = (await res.json()) as Partial<SettingsResponse> & {
        templates?: Partial<Record<CertTypeKey, Partial<TemplateState> | null>>;
      };
      // Normalize templates — server returns nulls for unset fields, the
      // UI's text inputs need strings. Walk all 4 type slots so the UI
      // always has a fully-populated TemplateState per type.
      const normalizedTemplates = makeEmptyTemplates();
      for (const { key } of CERT_TYPES) {
        const raw = json.templates?.[key] ?? null;
        normalizedTemplates[key] = {
          headerImage: raw?.headerImage ?? null,
          titleText: raw?.titleText ?? "",
          titleColor: raw?.titleColor ?? "#1a2e5a",
          bodyTemplate: raw?.bodyTemplate ?? "",
          signatures: (raw?.signatures as SignatureRow[]) ?? [],
          footerLogos: (raw?.footerLogos as FooterLogoRow[]) ?? [],
          footerText: raw?.footerText ?? "",
        };
      }
      const normalized: SettingsResponse = {
        cmeHours: json.cmeHours ?? null,
        accreditations: (json.accreditations as AccreditationRow[]) ?? [],
        designApprovedBy: json.designApprovedBy ?? null,
        designApprovedAt: json.designApprovedAt ?? null,
        templates: normalizedTemplates,
      };
      setDraft((current) => current ?? normalized);
      return normalized;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/events/${eventId}/certificates/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          details?: unknown;
        };
        throw new Error(err.error || `Save failed (${res.status})`);
      }
      return (await res.json()) as SettingsResponse;
    },
    onSuccess: (data) => {
      setDraft(data);
      queryClient.setQueryData(["cert-settings", eventId], data);
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dirty = useMemo(() => {
    if (!draft || !settingsQuery.data) return false;
    return JSON.stringify(draft) !== JSON.stringify(settingsQuery.data);
  }, [draft, settingsQuery.data]);

  const editable = draft ?? settingsQuery.data ?? null;

  function updateDraft(patch: Partial<SettingsResponse>) {
    setDraft((cur) => ({ ...(cur ?? settingsQuery.data!), ...patch }));
  }

  // The "current template" being edited — whichever type the inner
  // sub-tabs has active. All template-mutating helpers below scope to
  // this slot in the templates map.
  const currentTemplate = editable?.templates[activeTemplateType] ?? EMPTY_TEMPLATE;

  function updateCurrentTemplate(patch: Partial<TemplateState>) {
    if (!editable) return;
    updateDraft({
      templates: {
        ...editable.templates,
        [activeTemplateType]: { ...currentTemplate, ...patch },
      },
    });
  }

  // Accreditations (single, shared across cert types) ─────────────────
  function addAccreditation() {
    if (!editable) return;
    updateDraft({
      accreditations: [...editable.accreditations, { body: "", reference: "" }],
    });
  }
  function removeAccreditation(idx: number) {
    if (!editable) return;
    updateDraft({
      accreditations: editable.accreditations.filter((_, i) => i !== idx),
    });
  }
  function updateAccreditation(idx: number, patch: Partial<AccreditationRow>) {
    if (!editable) return;
    updateDraft({
      accreditations: editable.accreditations.map((a, i) =>
        i === idx ? { ...a, ...patch } : a,
      ),
    });
  }

  // Signatures (per active cert type) ─────────────────────────────────
  function addSignature() {
    updateCurrentTemplate({
      signatures: [...currentTemplate.signatures, { name: "", lines: [] }],
    });
  }
  function removeSignature(idx: number) {
    updateCurrentTemplate({
      signatures: currentTemplate.signatures.filter((_, i) => i !== idx),
    });
  }
  function updateSignature(idx: number, patch: Partial<SignatureRow>) {
    updateCurrentTemplate({
      signatures: currentTemplate.signatures.map((s, i) =>
        i === idx ? { ...s, ...patch } : s,
      ),
    });
  }

  // Footer logos (per active cert type) ───────────────────────────────
  function addFooterLogo() {
    updateCurrentTemplate({
      footerLogos: [...currentTemplate.footerLogos, { image: "", label: "" }],
    });
  }
  function removeFooterLogo(idx: number) {
    updateCurrentTemplate({
      footerLogos: currentTemplate.footerLogos.filter((_, i) => i !== idx),
    });
  }
  function updateFooterLogo(idx: number, patch: Partial<FooterLogoRow>) {
    updateCurrentTemplate({
      footerLogos: currentTemplate.footerLogos.map((l, i) =>
        i === idx ? { ...l, ...patch } : l,
      ),
    });
  }

  async function onSave() {
    if (!editable) return;
    const cleanedAccreditations = editable.accreditations
      .filter((a) => a.body !== "" && a.reference.trim().length > 0)
      .map((a) => ({
        body: a.body as AccreditorBody,
        reference: a.reference.trim(),
        hours: a.hours,
        officialStatement: a.officialStatement?.trim() || undefined,
      }));

    // Send all 4 type slots in one PATCH — each cleaned of empty rows
    // and trimmed strings. The server merges each slot into the
    // existing per-type template independently.
    const cleanedTemplates: Record<string, unknown> = {};
    for (const { key } of CERT_TYPES) {
      const t = editable.templates[key];
      cleanedTemplates[key] = {
        headerImage: t.headerImage || null,
        titleText: t.titleText.trim() || undefined,
        titleColor: t.titleColor,
        bodyTemplate: t.bodyTemplate,
        signatures: t.signatures
          .filter((s) => s.name.trim().length > 0)
          .map((s) => ({
            image: s.image || null,
            name: s.name.trim(),
            lines: s.lines.map((l) => l.trim()).filter(Boolean),
          })),
        footerLogos: t.footerLogos
          .filter((l) => l.image.trim().length > 0)
          .map((l) => ({
            image: l.image.trim(),
            label: l.label?.trim() || undefined,
          })),
        footerText: t.footerText.trim() || undefined,
      };
    }

    saveMutation.mutate({
      cmeHours: editable.cmeHours,
      accreditations: cleanedAccreditations,
      templates: cleanedTemplates,
    });
  }

  async function toggleApproval(approved: boolean) {
    if (!isSuperAdmin) return;
    saveMutation.mutate({ designApproved: approved });
  }

  async function showPreview() {
    setPreviewVisible(true);
    setPreviewBust((b) => b + 1);
    setPreviewProbe({ kind: "probing" });
    try {
      const res = await fetch(
        `/api/events/${eventId}/certificates/preview?type=${previewType}&t=${Date.now()}`,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        setPreviewProbe({ kind: "http-error", status: res.status, body });
        toast.error(`Preview failed: HTTP ${res.status}. Check /logs.`);
        console.error("[cert-preview] HTTP error", { status: res.status, body });
        return;
      }
      const buf = await res.arrayBuffer();
      setPreviewProbe({ kind: "ok", bytes: buf.byteLength });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPreviewProbe({ kind: "network-error", message });
      toast.error(`Preview network failure: ${message}`);
      console.error("[cert-preview] Network error", e);
    }
  }

  const previewSrc = `/api/events/${eventId}/certificates/preview?type=${previewType}&t=${previewBust}`;

  return (
    <div className="space-y-6 p-6">
      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <GraduationCap className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Certificates</h1>
            <p className="text-sm text-muted-foreground">
              Configure how this event&apos;s certificates look — banner, body,
              signatures, footer logos. Preview before issuing.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {dirty ? "Unsaved changes" : settingsQuery.data ? "All saved" : "Loading…"}
          </span>
          <Button
            onClick={onSave}
            disabled={!dirty || saveMutation.isPending}
            size="sm"
          >
            <Save className="h-4 w-4 mr-1" />
            Save changes
          </Button>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <Tabs defaultValue="template">
        <TabsList>
          <TabsTrigger value="template">
            <PenLine className="h-4 w-4 mr-1.5" />
            Template
          </TabsTrigger>
          <TabsTrigger value="cme">
            <FileText className="h-4 w-4 mr-1.5" />
            CME / CPD
          </TabsTrigger>
          <TabsTrigger value="preview">
            <Eye className="h-4 w-4 mr-1.5" />
            Preview
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Template editor ───────────────────────────────── */}
        <TabsContent value="template" className="space-y-6 mt-6">
          {/* Inner cert-type selector — switches which of the 4 templates
              (Attendance / Presenter / Poster / CME) the editor below
              binds to. State persists at page-level so the selection
              survives switching between outer tabs. */}
          <Tabs
            value={activeTemplateType}
            onValueChange={(v) => setActiveTemplateType(v as CertTypeKey)}
          >
            <TabsList className="grid w-full grid-cols-4">
              {CERT_TYPES.map((t) => (
                <TabsTrigger key={t.key} value={t.key}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="rounded-md border border-dashed border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            Editing the{" "}
            <strong className="text-foreground">
              {CERT_TYPES.find((t) => t.key === activeTemplateType)?.label}
            </strong>{" "}
            template. All 4 cert types have their own banner, body,
            signatures, and footer — switch tabs above to edit each.
          </div>

          {/* Header banner */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ImageIcon className="h-5 w-5" />
                Header banner
              </CardTitle>
              <CardDescription>
                Upload the event banner that appears across the top of every
                certificate. Design at roughly{" "}
                <strong>2480 × 700 pixels</strong> (A4 portrait top band) for the
                cleanest result. PNG or JPG.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="max-w-md">
                <PhotoUpload
                  value={currentTemplate.headerImage}
                  onChange={(url) => updateCurrentTemplate({ headerImage: url })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Title */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PaintBucket className="h-5 w-5" />
                Title
              </CardTitle>
              <CardDescription>
                The italic-script heading below the banner. Renders flanked by
                short navy bracket flourishes on each side.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 md:grid-cols-[1fr_180px]">
                <div>
                  <Label htmlFor="titleText">Title text</Label>
                  <Input
                    id="titleText"
                    placeholder="Certificate of Attendance"
                    value={currentTemplate.titleText}
                    onChange={(e) => updateCurrentTemplate({ titleText: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave blank to use the per-type default (e.g. &quot;Certificate
                    of CME&quot; for CME certs).
                  </p>
                </div>
                <div>
                  <Label htmlFor="titleColor">Title color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={currentTemplate.titleColor}
                      onChange={(e) => updateCurrentTemplate({ titleColor: e.target.value })}
                      className="h-9 w-12 rounded border cursor-pointer"
                      aria-label="Pick title color"
                    />
                    <Input
                      id="titleColor"
                      placeholder="#1a2e5a"
                      value={currentTemplate.titleColor}
                      onChange={(e) => updateCurrentTemplate({ titleColor: e.target.value })}
                      className="font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Body */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Body
              </CardTitle>
              <CardDescription>
                The cert body content. Use the toolbar to format text — bold
                event names, italic subtitles, headings for size. Insert{" "}
                <code className="bg-muted px-1 rounded">{`{{tokens}}`}</code>{" "}
                anywhere to merge real data at issue time. The renderer maps
                headings to size hierarchy: <strong>H2</strong> = recipient-
                name sized; <strong>H3</strong> = navy bold (good for event
                name); plain paragraph = body text.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <TiptapEditor
                content={currentTemplate.bodyTemplate}
                onChange={(html) => updateCurrentTemplate({ bodyTemplate: html })}
                placeholder="Compose the cert body — use H2 for the recipient line, paragraph for the rest..."
              />
              <details className="rounded-md border bg-muted/30 p-3 text-sm">
                <summary className="cursor-pointer font-medium">
                  Available tokens ({AVAILABLE_TOKENS.length})
                </summary>
                <div className="mt-3 space-y-1.5">
                  {AVAILABLE_TOKENS.map((t) => (
                    <div key={t.token} className="grid grid-cols-[200px_1fr] gap-2 text-xs">
                      <code className="bg-background px-1.5 py-0.5 rounded font-mono">
                        {t.token}
                      </code>
                      <span className="text-muted-foreground">{t.description}</span>
                    </div>
                  ))}
                </div>
              </details>
              <p className="text-xs text-muted-foreground">
                Tip — leave the body blank to use the per-cert-type default
                (matches the MASH IN FOCUS / EIGHC reference structure).
              </p>
            </CardContent>
          </Card>

          {/* Signatures */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PenLine className="h-5 w-5" />
                Signatures
              </CardTitle>
              <CardDescription>
                Conference chairman, co-chairmen, accreditation officer. Each
                signature renders side-by-side in the footer with the uploaded
                image above a signature line, then the name + title/affiliation
                below.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addSignature}
                  disabled={!editable}
                >
                  <Plus className="h-4 w-4 mr-1" /> Add signature
                </Button>
              </div>
              {currentTemplate.signatures.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No signatures yet — add the conference chairman / co-chairmen.
                </div>
              ) : (
                currentTemplate.signatures.map((sig, idx) => (
                  <div
                    key={idx}
                    className="rounded-md border p-4 grid gap-3 md:grid-cols-[200px_1fr_auto]"
                  >
                    <div>
                      <Label className="text-xs">Signature image</Label>
                      <PhotoUpload
                        value={sig.image ?? null}
                        onChange={(url) => updateSignature(idx, { image: url })}
                      />
                    </div>
                    <div className="space-y-2">
                      <div>
                        <Label className="text-xs">Name</Label>
                        <Input
                          placeholder="DR. AHMAD AL-RIFAI"
                          value={sig.name}
                          onChange={(e) =>
                            updateSignature(idx, { name: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          Lines below the name (one per line)
                        </Label>
                        <Textarea
                          rows={3}
                          placeholder={"Consultant Hepatologist & Gastroenterologist\nSheikh Shakhbout Medical City\nUnited Arab Emirates"}
                          value={sig.lines.join("\n")}
                          onChange={(e) =>
                            updateSignature(idx, {
                              lines: e.target.value.split("\n"),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeSignature(idx)}
                        aria-label="Remove signature"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Footer logos */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ImageIcon className="h-5 w-5" />
                Footer logos
              </CardTitle>
              <CardDescription>
                Society logos shown at the very bottom — &quot;Hosted by&quot;,
                &quot;In Collaboration with&quot;, &quot;Managed by&quot;, etc.
                Each logo can have an optional label above it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addFooterLogo}
                  disabled={!editable}
                >
                  <Plus className="h-4 w-4 mr-1" /> Add logo
                </Button>
              </div>
              {currentTemplate.footerLogos.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No footer logos — typical CME certs have 1-3 (hosting
                  society, accrediting body, managing partner).
                </div>
              ) : (
                currentTemplate.footerLogos.map((logo, idx) => (
                  <div
                    key={idx}
                    className="rounded-md border p-4 grid gap-3 md:grid-cols-[200px_1fr_auto]"
                  >
                    <div>
                      <Label className="text-xs">Logo image</Label>
                      <PhotoUpload
                        value={logo.image || null}
                        onChange={(url) =>
                          updateFooterLogo(idx, { image: url ?? "" })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Label (optional)</Label>
                      <Input
                        placeholder="Hosted by"
                        value={logo.label ?? ""}
                        onChange={(e) =>
                          updateFooterLogo(idx, { label: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeFooterLogo(idx)}
                        aria-label="Remove logo"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Footer text */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Footer text
              </CardTitle>
              <CardDescription>
                Rich text rendered below the footer logos — disclaimers,
                organization tag-lines, contact info, etc. Same toolbar as
                the body editor (bold / italic / links).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TiptapEditor
                content={currentTemplate.footerText}
                onChange={(html) => updateCurrentTemplate({ footerText: html })}
                placeholder="e.g. Meeting Minds Experts · www.meetingmindsexperts.com"
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: CME / CPD config ──────────────────────────────── */}
        <TabsContent value="cme" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle>CME / CPD configuration</CardTitle>
              <CardDescription>
                Per-event hours awarded and accrediting bodies. The CME body
                tokens (
                <code className="bg-muted px-1 rounded">{`{{accreditationBody}}`}</code>
                , <code className="bg-muted px-1 rounded">{`{{cmeHours}}`}</code>
                ) read from here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-2 max-w-xs">
                <Label htmlFor="cmeHours">Total CME / CPD hours awarded</Label>
                <Input
                  id="cmeHours"
                  type="number"
                  step="0.5"
                  min="0"
                  max="999.9"
                  placeholder="e.g. 18.0"
                  value={editable?.cmeHours ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateDraft({ cmeHours: v === "" ? null : Number(v) });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty if this event is not CME-accredited.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Accreditations</Label>
                    <p className="text-xs text-muted-foreground">
                      One row per accrediting body (events can carry multiple).
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addAccreditation}
                    disabled={!editable}
                  >
                    <Plus className="h-4 w-4 mr-1" /> Add accreditation
                  </Button>
                </div>
                {editable?.accreditations.length === 0 && (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No accreditations yet.
                  </div>
                )}
                {editable?.accreditations.map((row, idx) => (
                  <div
                    key={idx}
                    className="grid gap-3 rounded-md border p-3 md:grid-cols-[180px_1fr_120px_auto]"
                  >
                    <div>
                      <Label className="text-xs">Body</Label>
                      <Select
                        value={row.body}
                        onValueChange={(v) =>
                          updateAccreditation(idx, { body: v as AccreditorBody })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick accreditor" />
                        </SelectTrigger>
                        <SelectContent>
                          {ACCREDITOR_BODIES.map((b) => (
                            <SelectItem key={b} value={b}>
                              {b}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Reference</Label>
                      <Input
                        placeholder="e.g. DHA-CPD-2026-0142"
                        value={row.reference}
                        onChange={(e) =>
                          updateAccreditation(idx, { reference: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Hours (override)</Label>
                      <Input
                        type="number"
                        step="0.5"
                        placeholder="default"
                        value={row.hours ?? ""}
                        onChange={(e) =>
                          updateAccreditation(idx, {
                            hours:
                              e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="flex items-end">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeAccreditation(idx)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                    <div className="md:col-span-4">
                      <Label className="text-xs">
                        Official statement (override) — only if the accreditor
                        requires verbatim wording
                      </Label>
                      <Textarea
                        rows={2}
                        placeholder="e.g. This activity has been designated for a maximum of 18.0 European CME credits (ECMECs®)."
                        value={row.officialStatement ?? ""}
                        onChange={(e) =>
                          updateAccreditation(idx, {
                            officialStatement: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: Preview + design approval ─────────────────────── */}
        <TabsContent value="preview" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Preview
              </CardTitle>
              <CardDescription>
                Renders a draft PDF using <strong>real event data</strong> + a
                synthetic recipient (&quot;Dr. Sample Attendee&quot;). No
                certificate is created, no email is sent, no audit row is
                written.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="grid gap-2 min-w-[220px]">
                  <Label>Certificate type</Label>
                  <Select
                    value={previewType}
                    onValueChange={(v) => setPreviewType(v as CertType)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ATTENDANCE">Attendance</SelectItem>
                      <SelectItem value="PRESENTER">Presenter (Faculty)</SelectItem>
                      <SelectItem value="POSTER">Poster Presenter</SelectItem>
                      <SelectItem value="CME">CME</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={showPreview}>
                  <Eye className="h-4 w-4 mr-1" />
                  Generate preview
                </Button>
                {previewVisible && (
                  <a
                    href={previewSrc}
                    download={`preview-${previewType.toLowerCase()}.pdf`}
                    className="text-sm text-primary hover:underline"
                  >
                    Download PDF
                  </a>
                )}
                {dirty && (
                  <Badge variant="outline" className="ml-auto">
                    Save changes before preview to see them
                  </Badge>
                )}
              </div>
              {previewVisible ? (
                <>
                  {previewProbe.kind === "probing" && (
                    <div className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
                      Probing server response…
                    </div>
                  )}
                  {previewProbe.kind === "ok" && (
                    <div className="rounded-md border bg-green-50 px-3 py-2 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-400">
                      Server returned {previewProbe.bytes.toLocaleString()} bytes
                      of PDF.
                    </div>
                  )}
                  {previewProbe.kind === "http-error" && (
                    <div className="rounded-md border border-red-300 bg-red-50 px-3 py-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
                      <div className="font-semibold mb-1">
                        HTTP {previewProbe.status} from preview endpoint
                      </div>
                      <pre className="mt-1 whitespace-pre-wrap break-all bg-red-100/50 p-2 rounded font-mono dark:bg-red-900/40">
                        {previewProbe.body.slice(0, 800)}
                      </pre>
                    </div>
                  )}
                  {previewProbe.kind === "network-error" && (
                    <div className="rounded-md border border-red-300 bg-red-50 px-3 py-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
                      <div className="font-semibold mb-1">Network failure</div>
                      <div>{previewProbe.message}</div>
                    </div>
                  )}
                  <div className="rounded-md border overflow-hidden bg-muted">
                    <iframe
                      key={previewBust}
                      src={previewSrc}
                      className="w-full"
                      style={{ height: "800px" }}
                      title="Certificate preview"
                    />
                  </div>
                </>
              ) : (
                <div className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground">
                  Click <strong>Generate preview</strong> above to render a draft.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Design approval */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                Design approval
              </CardTitle>
              <CardDescription>
                Once the CEO/MD has signed off the cert design, flip this. The
                flag is required to enable the Issue button in Phase C.{" "}
                <strong>SUPER_ADMIN only.</strong>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {editable?.designApprovedBy ? (
                <div className="flex items-center justify-between rounded-md border bg-green-50 p-3 text-sm dark:bg-green-950/40">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span>
                      Approved on{" "}
                      <strong>
                        {new Date(editable.designApprovedAt!).toLocaleString()}
                      </strong>
                    </span>
                  </div>
                  {isSuperAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleApproval(false)}
                      disabled={saveMutation.isPending}
                    >
                      Revoke approval
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
                  <div className="flex items-center gap-2">
                    <Info className="h-4 w-4 text-amber-600" />
                    <span>
                      Design not yet approved — Issue button stays locked.
                    </span>
                  </div>
                  {isSuperAdmin ? (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="approve"
                        onCheckedChange={(c) => toggleApproval(c === true)}
                        disabled={saveMutation.isPending}
                      />
                      <Label htmlFor="approve" className="cursor-pointer">
                        Mark design approved
                      </Label>
                    </div>
                  ) : (
                    <Badge variant="outline">SUPER_ADMIN only</Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
