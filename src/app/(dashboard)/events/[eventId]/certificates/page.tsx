"use client";

/**
 * Certificates page — four tabs (v3 PDF-overlay model, 2026-06-02):
 *
 *   1. Template       — organizer uploads the finished cert PDF from
 *                       their designer (banner / borders / signatures /
 *                       footer logos all baked in) and drags text boxes
 *                       on top containing `{{tokens}}`. One template per
 *                       cert type (Attendance / Presenter / Poster / CME).
 *                       The canvas drag-and-drop editor lands in the
 *                       next commit — this tab currently shows a
 *                       placeholder with the architecture rationale.
 *   2. CME / CPD      — per-event hours awarded + accrediting bodies
 *                       (DHA/EACCME/etc) for CME certs. Independent of
 *                       the template; tokens render conditionally.
 *   3. Preview        — render any of the four cert types as PDF in
 *                       an iframe with background fetch probe so server
 *                       errors are visible. SUPER_ADMIN design-approval
 *                       gate lives here (it's the cert-design sign-off
 *                       step, naturally adjacent to the preview).
 *   4. Issue          — eligibility list + run progress (Phase C).
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
  FileText,
  PenLine,
  Send,
  Mail,
  XCircle,
  Loader2,
} from "lucide-react";
import type { CertificateTextBox } from "@/components/certificates/certificate-canvas-editor";

// Lazy-load the canvas editor so pdfjs-dist (~400KB) + react-rnd
// stay out of the dashboard's first-paint critical path. Same pattern
// as TiptapEditor was using before the v2→v3 flip.
const CertificateCanvasEditor = dynamic(
  () =>
    import("@/components/certificates/certificate-canvas-editor").then(
      (m) => m.CertificateCanvasEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-96 rounded border bg-muted/30 animate-pulse flex items-center justify-center text-sm text-muted-foreground">
        Loading canvas editor…
      </div>
    ),
  },
);

type CertType = "ATTENDANCE" | "APPRECIATION";

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;
type AccreditorBody = (typeof ACCREDITOR_BODIES)[number];

interface AccreditationRow {
  body: AccreditatorBodyOrEmpty;
  reference: string;
  hours?: number;
  officialStatement?: string;
}
type AccreditatorBodyOrEmpty = AccreditorBody | "";

/**
 * v3 PDF-overlay template state (2026-06-02). The organizer uploads a
 * finished cert PDF and positions text boxes on top with `{{tokens}}`.
 * The canvas drag-and-drop editor lands in the next commit — for now
 * the Template tab is a placeholder, but the state shape + persistence
 * round-trip is wired so the eventual editor just plugs in.
 *
 * `textBoxes` is intentionally typed loose here; the editor commit will
 * import the strict `CertificateTextBox` shape from
 * `src/lib/certificates/types.ts` and tighten this.
 */
interface TemplateState {
  backgroundPdfUrl: string | null;
  textBoxes: unknown[];
}

// Collapsed from 4 to 2 cert types on 2026-06-02 — designers hand
// the organizer two physical PDFs (Attendance + Appreciation) and the
// organizer modifies per-recipient text via {{tokens}} on overlaid
// text boxes. APPRECIATION absorbed the old PRESENTER + POSTER + CME
// slots; CME hours stay on the event row and render via tokens.
const CERT_TYPES = [
  { key: "ATTENDANCE", label: "Certificate of Attendance" },
  { key: "APPRECIATION", label: "Certificate of Appreciation" },
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
  backgroundPdfUrl: null,
  textBoxes: [],
};

function makeEmptyTemplates(): TemplatesByType {
  return {
    ATTENDANCE: { ...EMPTY_TEMPLATE },
    APPRECIATION: { ...EMPTY_TEMPLATE },
  };
}

// ── Issue tab API response shapes ─────────────────────────────────────────
interface EligibilityResp {
  type: CertTypeKey;
  eligibleCount: number;
  eligible: Array<{
    kind: "registration" | "speaker";
    registrationId: string | null;
    speakerId: string | null;
    recipientName: string;
    recipientEmail: string | null;
  }>;
  exclusions: Array<{ reason: string; count?: number }>;
}

interface RunResp {
  runId: string;
  type: CertTypeKey;
  status:
    | "PENDING"
    | "RENDERING"
    | "AWAITING_REVIEW"
    | "SENDING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED";
  totalCount: number;
  renderedCount: number;
  emailedCount: number;
  failedCount: number;
  progressPct: number;
  triggeredAt: string;
  rendererFinishedAt: string | null;
  emailerFinishedAt: string | null;
  lastTickAt: string | null;
  errors: unknown;
  sampleItems: Array<{
    id: string;
    recipientName: string;
    recipientEmail: string | null;
    renderedAt: string | null;
    emailedAt: string | null;
    errorPhase: string | null;
    errorMessage: string | null;
    issuedCertificateId: string | null;
  }>;
}

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
  // Per-type selector inside the Issue tab — independent of activeTemplateType
  // so the operator can be editing one type's template while reviewing
  // another type's run. Both default to ATTENDANCE.
  const [activeIssueType, setActiveIssueType] = useState<CertTypeKey>("ATTENDANCE");
  // Cached active runId per cert type — set when an issue is started or
  // when polling returns one. Lets the UI persist across tab switches
  // and survive a page reload (re-fetched via eligibility endpoint
  // returning the in-progress run).
  const [activeRunIds, setActiveRunIds] = useState<Partial<Record<CertTypeKey, string>>>({});
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

  // ── Issue tab queries + mutations ─────────────────────────────────
  // Eligibility for the active Issue type — query refetches when the
  // type changes. Returns count + sample names + exclusion reasons.
  const eligibilityQuery = useQuery<EligibilityResp>({
    queryKey: ["cert-eligibility", eventId, activeIssueType],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/eligible?type=${activeIssueType}`,
      );
      if (!res.ok) throw new Error(`Eligibility query failed (${res.status})`);
      return (await res.json()) as EligibilityResp;
    },
    staleTime: 30_000,
  });

  // Active run poll — fires once activeRunIds[type] is set, polls every
  // 4 sec while non-terminal so the progress bar tracks in near-real-time.
  const activeRunId = activeRunIds[activeIssueType] ?? null;
  const runQuery = useQuery<RunResp>({
    queryKey: ["cert-run", eventId, activeRunId],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/runs/${activeRunId}`,
      );
      if (!res.ok) throw new Error(`Run poll failed (${res.status})`);
      return (await res.json()) as RunResp;
    },
    enabled: !!activeRunId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 4000;
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) return false;
      return 4000;
    },
  });

  const issueMutation = useMutation({
    mutationFn: async (type: CertTypeKey) => {
      const res = await fetch(`/api/events/${eventId}/certificates/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        runId?: string;
        totalCount?: number;
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        const err = new Error(json.error ?? `Issue failed (${res.status})`);
        // Surface the existing runId on RUN_IN_PROGRESS so the UI can recover.
        (err as Error & { runId?: string }).runId = json.runId;
        throw err;
      }
      return json as { runId: string; totalCount: number };
    },
    onSuccess: (data) => {
      setActiveRunIds((cur) => ({ ...cur, [activeIssueType]: data.runId }));
      toast.success(`Issuing ${data.totalCount} certificates — cron will start within 60 seconds.`);
    },
    onError: (e: Error & { runId?: string }) => {
      if (e.runId) {
        // Adopt the in-progress run so the UI shows progress instead of an error.
        setActiveRunIds((cur) => ({ ...cur, [activeIssueType]: e.runId! }));
        toast(e.message);
      } else {
        toast.error(e.message);
      }
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/runs/${runId}/send`,
        { method: "POST" },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Send failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Emails are being sent — progress will update below.");
      queryClient.invalidateQueries({ queryKey: ["cert-run", eventId, activeRunId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/runs/${runId}/cancel`,
        { method: "POST" },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Cancel failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Run cancelled.");
      queryClient.invalidateQueries({ queryKey: ["cert-run", eventId, activeRunId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
          backgroundPdfUrl: raw?.backgroundPdfUrl ?? null,
          textBoxes: (raw?.textBoxes as unknown[]) ?? [],
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

  // Called by the canvas editor on every text-box add / move / resize /
  // edit and on backgroundPdfUrl upload. Scoped to the active cert type
  // sub-tab (Attendance or Appreciation).
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

  // v2 signature + footer-logo helpers were dropped in the 2026-06-02
  // architecture flip — the canvas editor (next commit) owns text-box
  // CRUD via the `textBoxes` array directly.

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

    // Send all 4 type slots in one PATCH. v3 shape is intentionally
    // small — `backgroundPdfUrl` (the uploaded designer PDF) plus the
    // text-box array (the canvas editor's output, populated in the
    // next commit). The server merges each slot independently.
    const cleanedTemplates: Record<string, unknown> = {};
    for (const { key } of CERT_TYPES) {
      const t = editable.templates[key];
      cleanedTemplates[key] = {
        backgroundPdfUrl: t.backgroundPdfUrl || null,
        textBoxes: t.textBoxes,
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
          <TabsTrigger value="issue">
            <Send className="h-4 w-4 mr-1.5" />
            Issue
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
            <TabsList className="grid w-full grid-cols-2">
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
            template — one slot per cert type.
          </div>

          {/* v3 PDF-overlay canvas editor (Commit 3, 2026-06-02). Lazy-
              loaded so pdfjs-dist + react-rnd stay out of the dashboard's
              first-paint critical path. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Background PDF + text boxes
              </CardTitle>
              <CardDescription>
                The certificate design comes from a finished PDF you upload
                (banner, borders, signatures, footer logos all baked in by
                your designer), with positioned text boxes overlaid on top
                containing{" "}
                <code className="bg-muted px-1 rounded">{`{{tokens}}`}</code>{" "}
                that resolve per recipient at issue time. Drag boxes to
                reposition, pull a corner to resize.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CertificateCanvasEditor
                backgroundPdfUrl={currentTemplate.backgroundPdfUrl}
                textBoxes={currentTemplate.textBoxes as CertificateTextBox[]}
                onChange={(patch) => {
                  // Coerce to the loose TemplateState shape held by the
                  // page; the editor emits the strict CertificateTextBox[]
                  // type which is structurally compatible.
                  const next: Partial<TemplateState> = {};
                  if (patch.backgroundPdfUrl !== undefined) {
                    next.backgroundPdfUrl = patch.backgroundPdfUrl;
                  }
                  if (patch.textBoxes !== undefined) {
                    next.textBoxes = patch.textBoxes;
                  }
                  updateCurrentTemplate(next);
                }}
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
                      <SelectItem value="ATTENDANCE">Certificate of Attendance</SelectItem>
                      <SelectItem value="APPRECIATION">Certificate of Appreciation</SelectItem>
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

        {/* ── Tab 4: Issue ─────────────────────────────────────────── */}
        <TabsContent value="issue" className="space-y-6 mt-6">
          <Tabs
            value={activeIssueType}
            onValueChange={(v) => setActiveIssueType(v as CertTypeKey)}
          >
            <TabsList className="grid w-full grid-cols-2">
              {CERT_TYPES.map((t) => (
                <TabsTrigger key={t.key} value={t.key}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Active run panel (shown if there's an in-flight run for this
              cert type) — takes precedence over the "Issue" CTA so the
              operator focuses on the live thing. */}
          {runQuery.data && runQuery.data.status !== "CANCELLED" && (
            <RunProgressCard
              run={runQuery.data}
              onSend={() => sendMutation.mutate(runQuery.data!.runId)}
              onCancel={() => cancelMutation.mutate(runQuery.data!.runId)}
              sending={sendMutation.isPending}
              cancelling={cancelMutation.isPending}
            />
          )}

          {/* Eligibility + Issue CTA — visible always, even when a run
              is in progress, so the operator sees the current cohort.
              The Issue button is disabled if a non-terminal run is
              already live for this type (server returns 409 + we re-
              adopt the runId). */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                Eligible recipients
              </CardTitle>
              <CardDescription>
                {eligibilityQuery.isLoading
                  ? "Loading eligibility…"
                  : eligibilityQuery.data
                    ? `${eligibilityQuery.data.eligibleCount} recipient${eligibilityQuery.data.eligibleCount === 1 ? "" : "s"} not yet issued a ${CERT_TYPES.find((t) => t.key === activeIssueType)?.label} certificate.`
                    : "Failed to load eligibility."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {eligibilityQuery.data?.exclusions.length ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm dark:bg-amber-950/30">
                  <div className="font-semibold mb-1 flex items-center gap-2">
                    <Info className="h-4 w-4 text-amber-600" />
                    Blocking conditions
                  </div>
                  <ul className="list-disc pl-5 space-y-1 text-amber-900 dark:text-amber-300">
                    {eligibilityQuery.data.exclusions.map((e, i) => (
                      <li key={i}>{e.reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {eligibilityQuery.data && eligibilityQuery.data.eligibleCount > 0 ? (
                <details className="rounded-md border bg-muted/30 p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Sample recipients ({Math.min(eligibilityQuery.data.eligible.length, 20)}{" "}
                    of {eligibilityQuery.data.eligibleCount})
                  </summary>
                  <ul className="mt-3 space-y-1 max-h-60 overflow-y-auto">
                    {eligibilityQuery.data.eligible.slice(0, 20).map((r, i) => (
                      <li key={i} className="text-xs grid grid-cols-[1fr_auto] gap-2 py-0.5">
                        <span>{r.recipientName}</span>
                        <span className="text-muted-foreground font-mono">
                          {r.recipientEmail ?? "(no email)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="flex items-center justify-between border-t pt-4">
                <p className="text-xs text-muted-foreground max-w-md">
                  Two-phase issue — PDFs render first (cron picks up within
                  60s), then you review them in the AWAITING_REVIEW gate
                  before emails go out.
                </p>
                <Button
                  onClick={() => issueMutation.mutate(activeIssueType)}
                  disabled={
                    issueMutation.isPending ||
                    !eligibilityQuery.data ||
                    eligibilityQuery.data.eligibleCount === 0 ||
                    !!runQuery.data
                  }
                >
                  {issueMutation.isPending && (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  )}
                  <Send className="h-4 w-4 mr-1" />
                  Issue {eligibilityQuery.data?.eligibleCount ?? 0} certificate
                  {eligibilityQuery.data?.eligibleCount === 1 ? "" : "s"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── RunProgressCard — the live progress UI for an in-flight run ─────────────
//
// Renders the run's progress bar, current phase, sample items, and the
// stage-appropriate action buttons (Send when AWAITING_REVIEW, Cancel
// when not terminal). Polling is handled by the parent's runQuery so
// this component is a pure render of the latest snapshot.

function RunProgressCard({
  run,
  onSend,
  onCancel,
  sending,
  cancelling,
}: {
  run: RunResp;
  onSend: () => void;
  onCancel: () => void;
  sending: boolean;
  cancelling: boolean;
}) {
  const isTerminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);
  const phaseLabel: Record<RunResp["status"], string> = {
    PENDING: "Queued — cron will start rendering within 60 seconds",
    RENDERING: `Rendering PDFs (${run.renderedCount} / ${run.totalCount})`,
    AWAITING_REVIEW: "All PDFs rendered — review then send emails",
    SENDING: `Sending emails (${run.emailedCount} / ${run.totalCount})`,
    COMPLETED: "Run complete",
    FAILED: "Run failed",
    CANCELLED: "Run cancelled",
  };
  const statusColor: Record<RunResp["status"], string> = {
    PENDING: "bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/30 dark:text-blue-300",
    RENDERING: "bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/30 dark:text-blue-300",
    AWAITING_REVIEW: "bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
    SENDING: "bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950/30 dark:text-blue-300",
    COMPLETED: "bg-green-50 border-green-200 text-green-900 dark:bg-green-950/30 dark:text-green-300",
    FAILED: "bg-red-50 border-red-200 text-red-900 dark:bg-red-950/30 dark:text-red-300",
    CANCELLED: "bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-950/30 dark:text-gray-400",
  };

  return (
    <Card className={`border ${statusColor[run.status]}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {run.status === "AWAITING_REVIEW" ? (
            <Mail className="h-5 w-5" />
          ) : run.status === "COMPLETED" ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : run.status === "FAILED" || run.status === "CANCELLED" ? (
            <XCircle className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
          {phaseLabel[run.status]}
        </CardTitle>
        <CardDescription>
          Run ID: <code className="font-mono">{run.runId.slice(-8)}</code>
          {run.lastTickAt && (
            <>
              {" · "}Last cron tick: {new Date(run.lastTickAt).toLocaleTimeString()}
            </>
          )}
          {run.failedCount > 0 && (
            <>
              {" · "}
              <span className="text-red-700 dark:text-red-400 font-semibold">
                {run.failedCount} failed
              </span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span>
              {run.renderedCount} rendered · {run.emailedCount} emailed ·{" "}
              {run.totalCount} total
            </span>
            <span className="font-semibold">{run.progressPct}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${run.progressPct}%` }}
            />
          </div>
        </div>

        {/* Action buttons by status */}
        {run.status === "AWAITING_REVIEW" && (
          <div className="flex gap-2 flex-wrap">
            <Button onClick={onSend} disabled={sending}>
              {sending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              <Send className="h-4 w-4 mr-1" />
              Approve &amp; send {run.totalCount} emails
            </Button>
            <Button variant="outline" onClick={onCancel} disabled={cancelling}>
              <XCircle className="h-4 w-4 mr-1" />
              Cancel run
            </Button>
          </div>
        )}
        {!isTerminal && run.status !== "AWAITING_REVIEW" && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
              <XCircle className="h-4 w-4 mr-1" />
              Cancel run
            </Button>
          </div>
        )}
        {run.status === "FAILED" && (
          <div className="text-sm">
            Re-issue support coming in v1.1. For now, cancel + start a
            fresh run; the @@unique constraint on IssuedCertificate
            prevents duplicates for already-issued recipients.
          </div>
        )}

        {/* Sample items — first 20 with progress state */}
        <details className="rounded-md border bg-background p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Sample recipients ({run.sampleItems.length})
          </summary>
          <table className="mt-3 w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-1">Recipient</th>
                <th className="text-left font-medium py-1">Email</th>
                <th className="text-left font-medium py-1">Rendered</th>
                <th className="text-left font-medium py-1">Emailed</th>
              </tr>
            </thead>
            <tbody>
              {run.sampleItems.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="py-1">{it.recipientName}</td>
                  <td className="py-1 font-mono text-muted-foreground">
                    {it.recipientEmail ?? "—"}
                  </td>
                  <td className="py-1">
                    {it.renderedAt ? "✓" : it.errorPhase === "render" ? "✗" : "…"}
                  </td>
                  <td className="py-1">
                    {it.emailedAt ? "✓" : it.errorPhase === "email" ? "✗" : "…"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </CardContent>
    </Card>
  );
}
