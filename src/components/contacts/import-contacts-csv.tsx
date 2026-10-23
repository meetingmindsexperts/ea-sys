"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileDown, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Contacts CSV import with the help a first-time user needs (Oct 23, 2026).
 * "Import CSV" opens a short explanation before the file picker, and the result
 * opens a dialog that lists every row that failed and every value left blank:
 * the old toast said only "3 errors", and "5,000 skipped (duplicates)" left
 * people thinking their edits to existing contacts had been saved.
 */

// Identity fields grouped first, matching the registrations and speakers
// templates. Column order is presentation only; the importer resolves every
// column by name, and these are the names the export writes.
const TEMPLATE_HEADER =
  "title,firstName,lastName,email,phone,additionalEmail,organization,jobTitle,specialty,customSpecialty,role,registrationType,city,state,zipCode,country,associationName,memberId,studentId,studentIdExpiry,bio,tags,notes";
const TEMPLATE_EXAMPLE =
  'Dr,John,Smith,john@example.com,+1-555-0123,,Acme Corp,CEO,Cardiology,,PHYSICIAN,Physician,Dubai,,,United Arab Emirates,,,,,,"VIP, Speaker",Met at conference 2025';

export function downloadContactsTemplate() {
  const blob = new Blob([[TEMPLATE_HEADER, TEMPLATE_EXAMPLE].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "contacts-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
  warnings: string[];
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function ImportContactsCsv({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const chooseFile = () => {
    setHelpOpen(false);
    fileRef.current?.click();
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    const toastId = toast.loading(`Importing ${file.name}… you can keep working.`, { duration: Infinity });

    fetch("/api/contacts/import", { method: "POST", body: formData })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Import failed");
        toast.dismiss(toastId);
        const r: ImportResult = { created: json.created, skipped: json.skipped, errors: json.errors ?? [], warnings: json.warnings ?? [] };
        onImported();
        // A clean import needs no dialog; anything skipped or left out does.
        if (r.skipped === 0 && r.errors.length === 0 && r.warnings.length === 0) {
          toast.success(`Imported ${plural(r.created, "new contact", "new contacts")}.`);
          return;
        }
        setResult(r);
      })
      .catch((err: unknown) => {
        toast.dismiss(toastId);
        toast.error(err instanceof Error ? err.message : "Import failed", {
          description: "Nothing was imported. Check the file is a CSV with firstName, lastName and email columns.",
        });
      });
  };

  return (
    <>
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
      <Button
        variant="outline"
        size="sm"
        onClick={() => setHelpOpen(true)}
        className="h-8 text-xs border-gray-200 text-gray-600 hover:text-gray-900"
      >
        <Upload className="h-3.5 w-3.5 mr-1.5" />
        Import CSV
      </Button>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import contacts from a CSV file</DialogTitle>
            <DialogDescription>Read this once before you import. It takes a minute and saves surprises.</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-sm text-foreground">
            <li>
              <strong>Required columns:</strong> firstName, lastName and email. Everything else is optional.
              Download the template to see every column name.
            </li>
            <li>
              <strong>Adds new people only.</strong> If an email is already in your contacts, that row is
              skipped and the existing contact is <strong>not changed</strong>. To fix an existing contact,
              open it and edit it.
            </li>
            <li>A file you exported from this page can be imported back with the same column names.</li>
            <li>
              <strong>Editing in Excel?</strong>{" "}Keep dates as YYYY-MM-DD (for example 2027-06-30) and save
              with &ldquo;CSV UTF-8&rdquo;. Excel can change dates and drop leading zeros otherwise.
            </li>
            <li>Up to 5,000 rows per file. After the import you will see what was added and anything that was not.</li>
          </ul>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={downloadContactsTemplate}>
              <FileDown className="h-4 w-4 mr-1.5" />
              Download template
            </Button>
            <Button onClick={chooseFile}>
              <Upload className="h-4 w-4 mr-1.5" />
              Choose CSV file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={result !== null} onOpenChange={(open) => { if (!open) setResult(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import finished</DialogTitle>
            <DialogDescription>Here is what happened to each row of your file.</DialogDescription>
          </DialogHeader>
          {result && <ImportSummary result={result} />}
          <DialogFooter>
            <Button onClick={() => setResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ImportSummary({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-4 text-sm max-h-[60vh] overflow-y-auto pr-1">
      <p>
        <strong>{plural(result.created, "new contact was", "new contacts were")}</strong> added.
      </p>
      {result.skipped > 0 && (
        <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
          <strong>{plural(result.skipped, "row was", "rows were")} skipped</strong> because the email is already
          in your contacts. Those contacts were <strong>not changed</strong>. Import only adds new people; to
          update someone, open their contact and edit it.
        </p>
      )}
      <MessageList
        title={`${plural(result.errors.length, "row was", "rows were")} not imported`}
        hint="Fix these rows in your file and import it again. Rows already imported will be skipped."
        items={result.errors}
        tone="error"
      />
      <MessageList
        title="Imported, but some values were left blank"
        hint="These contacts were added. Fix the values in the file for next time, or edit the contacts directly."
        items={result.warnings}
        tone="warning"
      />
    </div>
  );
}

function MessageList({
  title,
  hint,
  items,
  tone,
}: {
  title: string;
  hint: string;
  items: string[];
  tone: "error" | "warning";
}) {
  if (items.length === 0) return null;
  const box =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
      : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100";
  return (
    <div className={`rounded-md border px-3 py-2 ${box}`}>
      <p className="font-medium">{title}</p>
      <p className="text-xs opacity-80 mb-1.5">{hint}</p>
      <ul className="list-disc pl-5 space-y-0.5 text-xs">
        {items.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
