import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";

const PREFIX = "mmg_";

/** Generate a new plaintext API key — returned once to the caller, never stored. */
export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString("hex");
}

/** SHA-256 hash of the full key string — stored in the database. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The first 12 chars of the key (prefix + 8 chars) used for display. */
export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}

/** Validate an API key from a request header. Returns the organizationId or null. */
export async function validateApiKey(rawKey: string): Promise<{ organizationId: string } | null> {
  if (!rawKey.startsWith(PREFIX)) return null;

  const hash = hashApiKey(rawKey);

  const apiKey = await db.apiKey.findUnique({
    where: { keyHash: hash },
    select: {
      id: true,
      organizationId: true,
      isActive: true,
      expiresAt: true,
    },
  });

  if (!apiKey || !apiKey.isActive) return null;
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

  // Update lastUsedAt non-blocking
  db.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { organizationId: apiKey.organizationId };
}
