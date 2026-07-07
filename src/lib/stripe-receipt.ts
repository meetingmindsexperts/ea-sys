import { randomUUID } from "crypto";
import { apiLogger } from "@/lib/logger";
import { uploadStripeReceipt } from "@/lib/storage";

/**
 * Stripe's `charge.receipt_url` is an HTML hosted page (Stripe has no API for a
 * PDF of it). We download that HTML at settlement time and re-host a durable
 * local snapshot, so the receipt survives even if Stripe's URL later breaks.
 *
 * Fully failure-isolated: NEVER throws (returns null on any problem) — it runs
 * fire-and-forget off the payment webhook and must never affect payment
 * processing. SSRF-guarded: only fetches Stripe-hosted URLs.
 */

/** Only these hosts are ever fetched — the URL comes from Stripe, but guard anyway. */
function isStripeReceiptHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "stripe.com" || host === "pay.stripe.com" || host.endsWith(".stripe.com");
  } catch {
    return false;
  }
}

/**
 * Download the Stripe receipt page and store a local snapshot.
 * @returns the stored path/URL (e.g. `/uploads/stripe-receipts/2026/07/<id>.html`)
 *          or null if the URL is missing / not a Stripe host / the fetch fails.
 */
export async function captureStripeReceipt(receiptUrl: string | null | undefined): Promise<string | null> {
  if (!receiptUrl) return null;
  if (!isStripeReceiptHost(receiptUrl)) {
    apiLogger.warn({ msg: "stripe-receipt:non-stripe-host-skipped", receiptUrl });
    return null;
  }

  try {
    const res = await fetch(receiptUrl, { signal: AbortSignal.timeout(10000), redirect: "follow" });
    if (!res.ok) {
      apiLogger.warn({ msg: "stripe-receipt:fetch-failed", receiptUrl, status: res.status });
      return null;
    }
    const html = await res.text();
    if (!html || html.length < 100) {
      apiLogger.warn({ msg: "stripe-receipt:empty-body", receiptUrl, length: html?.length ?? 0 });
      return null;
    }
    const stored = await uploadStripeReceipt(Buffer.from(html, "utf8"), `${randomUUID()}.html`);
    apiLogger.info({ msg: "stripe-receipt:snapshot-stored", stored });
    return stored;
  } catch (err) {
    apiLogger.error({ err, msg: "stripe-receipt:capture-failed", receiptUrl });
    return null;
  }
}
