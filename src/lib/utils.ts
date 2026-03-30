import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(
  amount: number,
  currency: string = "USD"
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

// Asia/Dubai (GST) = UTC+4, no DST. UTC-based helpers below.
// Shifting by +4h then using UTC accessors gives consistent output
// on both server and client (no locale-dependent Intl variance).
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

function toDubai(date: Date | string): Date {
  return new Date(new Date(date).getTime() + DUBAI_OFFSET_MS);
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** e.g. "Jan 25, 2026" (Asia/Dubai) */
export function formatDate(date: Date | string): string {
  const d = toDubai(date);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** e.g. "Jan 25, 2026, 2:30 PM GST" (Asia/Dubai) */
export function formatDateTime(date: Date | string): string {
  const d = toDubai(date);
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hour12}:${minuteStr} ${ampm} GST`;
}

/** e.g. "Jan 25, 2026 - Jan 27, 2026" */
export function formatDateRange(start: Date | string, end: Date | string): string {
  const startStr = formatDate(start);
  const endStr = formatDate(end);
  return startStr === endStr ? startStr : `${startStr} - ${endStr}`;
}

/** e.g. "Saturday, January 25, 2026" (Asia/Dubai) */
export function formatDateLong(date: Date | string): string {
  const d = toDubai(date);
  return `${DAYS_LONG[d.getUTCDay()]}, ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** e.g. "2:30 PM GST" (Asia/Dubai) */
export function formatTime(date: Date | string): string {
  const d = toDubai(date);
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  return `${hour12}:${minuteStr} ${ampm} GST`;
}

const TITLE_LABELS: Record<string, string> = {
  DR: "Dr.",
  MR: "Mr.",
  MRS: "Mrs.",
  MS: "Ms.",
  PROF: "Prof.",
};

/** Format a person's name with optional title prefix, e.g. "Dr. John Smith" */
export function formatPersonName(
  title: string | null | undefined,
  firstName: string,
  lastName: string
): string {
  const prefix = title && TITLE_LABELS[title] ? `${TITLE_LABELS[title]} ` : "";
  return `${prefix}${firstName} ${lastName}`.trim();
}

/** Get the display label for a title enum value, e.g. "DR" → "Dr." */
export function getTitleLabel(title: string | null | undefined): string {
  if (!title) return "";
  return TITLE_LABELS[title] || "";
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateBarcode(): string {
  return `${Date.now()}${Math.random().toString().slice(2, 8)}`;
}

/** @deprecated Use generateBarcode() instead */
export const generateQRCode = generateBarcode;

/** Normalize a tag to Title Case and collapse whitespace. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
