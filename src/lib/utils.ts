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

export function formatDate(date: Date | string): string {
  const d = new Date(date);
  // Use UTC methods to ensure consistent output between server and client
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function formatDateTime(date: Date | string): string {
  const d = new Date(date);
  // Use UTC methods to ensure consistent output between server and client
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hour12}:${minuteStr} ${ampm}`;
}

export function formatDateRange(start: Date | string, end: Date | string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);

  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  if (startStr === endStr) {
    return startStr;
  }

  return `${startStr} - ${endStr}`;
}

export function formatDateLong(date: Date | string): string {
  const d = new Date(date);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function formatTime(date: Date | string): string {
  const d = new Date(date);
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const minuteStr = minutes.toString().padStart(2, "0");
  return `${hour12}:${minuteStr} ${ampm}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateQRCode(): string {
  return `QR-${Date.now()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
}
