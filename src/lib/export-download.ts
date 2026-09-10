/**
 * Fetch-then-save for authenticated file exports (client-side).
 *
 * A bare `<a href download>` cannot see a 403 or a lapsed session: the browser
 * happily saves the error JSON under the .csv/.docx name the link asked for and
 * the failure is silent. That is the April 2026 `quote.json` lesson, and it is
 * why every export button fetches first, checks the status, and only then hands
 * the bytes to the browser.
 *
 * Shared by the Abstracts and Session Proposals export menus so the two cannot
 * drift on error handling.
 */
export interface DownloadExportArgs {
  url: string;
  filename: string;
  /** Log key, e.g. "abstracts:export-failed". */
  logKey: string;
  /** Shown when the server refuses (403) without its own message. */
  forbiddenMessage: string;
}

export interface DownloadExportResult {
  ok: boolean;
  /** Present when `ok` is false — ready to hand to a toast. */
  error?: string;
}

export async function downloadExport(args: DownloadExportArgs): Promise<DownloadExportResult> {
  try {
    const res = await fetch(args.url);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(args.logKey, res.status, json);
      return {
        ok: false,
        error: json.error || (res.status === 403 ? args.forbiddenMessage : "Export failed."),
      };
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = args.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true };
  } catch (err) {
    console.error(`${args.logKey}-error`, err);
    return { ok: false, error: "Export failed. Please try again." };
  }
}
