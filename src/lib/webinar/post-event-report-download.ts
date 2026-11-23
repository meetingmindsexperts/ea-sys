/**
 * Downloads the post-event report's PDF (review of cdec0c859): fetched, not an <a download>, so a
 * refusal (too many downloads, not found, a failure) is said in a message instead of saving the error
 * as a file or doing nothing. Client-side.
 */
export async function downloadPostEventReportPdf(eventId: string, opts: { includeComments: boolean }): Promise<void> {
  const res = await fetch(`/api/events/${eventId}/webinar/post-event-report?format=pdf${opts.includeComments ? "&comments=1" : ""}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || "Could not download the report.");
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "post-event-report.pdf";
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
