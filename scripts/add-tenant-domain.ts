/**
 * Map a hostname to an organization for multi-tenant routing (TenantDomain).
 *
 * This is THE way tenant domains get seeded — deliberately an ops script, not
 * a data migration (a migration would guess org rows and run on every
 * environment, including the future fresh platform DB where the guess would be
 * wrong). Idempotent: re-running with the same domain updates the row in
 * place, so a typo'd org mapping is fixed by re-running with the right org.
 *
 * The host→org resolver (src/lib/tenant/resolver.ts) micro-caches lookups for
 * ~60s per container, so a new/changed mapping takes up to a minute to apply.
 *
 * Usage:
 *   npx tsx scripts/add-tenant-domain.ts <domain> <orgIdOrSlug> [--primary] [--verified]
 *   npx tsx scripts/add-tenant-domain.ts --list
 *
 * Examples:
 *   npx tsx scripts/add-tenant-domain.ts events.meetingmindsgroup.com mm-group --primary --verified
 *   npx tsx scripts/add-tenant-domain.ts --list
 */
import { db } from "../src/lib/db";

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

/** Same normalization the runtime resolver applies: lowercase, no port, no trailing dot. */
function normalizeDomainArg(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!host || /[\s/]/.test(host)) fail(`"${raw}" does not look like a hostname`);
  return host;
}

async function list() {
  const rows = await db.tenantDomain.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      domain: true,
      isPrimary: true,
      verifiedAt: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  if (rows.length === 0) {
    console.log("No tenant domains configured (resolver falls back per DEFAULT_ORG_ID / unscoped).");
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.domain} → ${r.organization.name} (${r.organization.slug}, ${r.organization.id})` +
        `${r.isPrimary ? " [primary]" : ""}${r.verifiedAt ? " [verified]" : " [unverified]"}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    await list();
    return;
  }

  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 2) {
    fail(
      "usage: add-tenant-domain.ts <domain> <orgIdOrSlug> [--primary] [--verified]  (or --list)",
    );
  }
  const domain = normalizeDomainArg(positional[0]);
  const orgRef = positional[1];
  const isPrimary = args.includes("--primary");
  const verified = args.includes("--verified");

  const org = await db.organization.findFirst({
    where: { OR: [{ id: orgRef }, { slug: orgRef }] },
    select: { id: true, name: true, slug: true },
  });
  if (!org) fail(`no organization found with id or slug "${orgRef}"`);

  const existing = await db.tenantDomain.findUnique({
    where: { domain },
    select: { organizationId: true, organization: { select: { name: true } } },
  });
  if (existing && existing.organizationId !== org.id) {
    console.log(
      `Re-pointing ${domain}: ${existing.organization.name} → ${org.name}`,
    );
  }

  const row = await db.tenantDomain.upsert({
    where: { domain },
    create: {
      domain,
      organizationId: org.id,
      isPrimary,
      verifiedAt: verified ? new Date() : null,
    },
    update: {
      organizationId: org.id,
      isPrimary,
      // --verified stamps now; omitting it PRESERVES an existing verifiedAt
      // (re-running without the flag must not un-verify a live domain).
      ...(verified ? { verifiedAt: new Date() } : {}),
    },
  });

  console.log(
    `Mapped ${row.domain} → ${org.name} (${org.slug}, ${org.id})` +
      `${row.isPrimary ? " [primary]" : ""}${row.verifiedAt ? " [verified]" : " [unverified]"}`,
  );
  console.log(
    "Note: the per-container resolver cache holds up to ~60s before this applies.",
  );
}

main()
  .catch((err) => {
    console.error("add-tenant-domain failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
