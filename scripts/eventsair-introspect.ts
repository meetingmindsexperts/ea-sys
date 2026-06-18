/**
 * Read-only EventsAir GraphQL schema probe.
 *
 * Purpose: discover the EXACT field names EventsAir exposes for a
 * registration's **category / registration type** and its **payment /
 * attendance** status, so we can extend the import mapper without guessing.
 * The current import only reads `event { contacts { ... } }` (a CRM view);
 * category + payment almost certainly live on a different object, so we
 * introspect the schema to find out where.
 *
 * This script is STRICTLY READ-ONLY:
 *   - It runs GraphQL introspection queries (`__schema` / `__type`) only.
 *   - It performs NO mutations and writes NOTHING to either database.
 *   - It touches no core write paths — it reuses the existing OAuth + query
 *     plumbing via the additive `rawGraphQL` export.
 *
 * Usage:
 *   npx tsx scripts/eventsair-introspect.ts
 *
 * It auto-selects the first organization that has EventsAir credentials
 * configured. Paste the printed output back so we can finalize the mapping.
 */

import { PrismaClient } from "@prisma/client";
import { decryptSecret, rawGraphQL, type EventsAirCredentials } from "@/lib/eventsair-client";

const db = new PrismaClient();

// Type names whose fields we want to inspect in full. We always inspect the
// root Query type, Event, and Contact, then auto-discover any type whose name
// hints at registration/payment/category/attendance and inspect those too.
const NAME_HINT =
  /(registration|registrant|attendee|payment|paid|categor|function|ticket|fee|transaction|balance|invoice|status|attendance)/i;

interface TypeRef {
  name: string | null;
  kind: string;
  ofType?: TypeRef | null;
}
interface FieldDef {
  name: string;
  type: TypeRef;
  args?: { name: string; type: TypeRef }[];
}
interface FullType {
  name: string;
  kind: string;
  fields: FieldDef[] | null;
}

/** Flatten a possibly-wrapped (NON_NULL / LIST) type ref to a readable label. */
function typeLabel(t: TypeRef | null | undefined): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeLabel(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeLabel(t.ofType)}]`;
  return t.name ?? "?";
}

/** Unwrap to the underlying named type (skipping NON_NULL / LIST wrappers). */
function namedType(t: TypeRef | null | undefined): string | null {
  if (!t) return null;
  if (t.ofType) return namedType(t.ofType);
  return t.name;
}

const TYPE_QUERY = `
  query Introspect($name: String!) {
    __type(name: $name) {
      name
      kind
      fields(includeDeprecated: true) {
        name
        args { name type { kind name ofType { kind name ofType { kind name } } } }
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
`;

async function fetchType(creds: EventsAirCredentials, name: string): Promise<FullType | null> {
  try {
    const data = await rawGraphQL<{ __type: FullType | null }>(creds, TYPE_QUERY, { name });
    return data.__type;
  } catch (err) {
    console.warn(`  ! could not introspect type "${name}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function printType(t: FullType): string[] {
  const childTypeNames: string[] = [];
  console.log(`\n━━━ type ${t.name} (${t.kind}) ━━━`);
  if (!t.fields) {
    console.log("  (no fields — enum/scalar/union)");
    return childTypeNames;
  }
  for (const f of t.fields) {
    const argStr = f.args && f.args.length ? `(${f.args.map((a) => `${a.name}: ${typeLabel(a.type)}`).join(", ")})` : "";
    console.log(`  ${f.name}${argStr}: ${typeLabel(f.type)}`);
    const named = namedType(f.type);
    if (named) childTypeNames.push(named);
  }
  return childTypeNames;
}

async function main() {
  const orgs = await db.organization.findMany({ select: { id: true, name: true, settings: true } });
  const org = orgs.find((o) => {
    const cfg = (o.settings as Record<string, unknown> | null)?.eventsAir as Record<string, unknown> | undefined;
    return cfg?.clientId && cfg?.clientSecretEncrypted;
  });
  if (!org) {
    console.error("No organization has EventsAir credentials configured. Aborting.");
    process.exit(1);
  }
  const cfg = (org.settings as Record<string, unknown>).eventsAir as Record<string, unknown>;
  const creds: EventsAirCredentials = {
    clientId: cfg.clientId as string,
    clientSecret: decryptSecret(cfg.clientSecretEncrypted as string),
  };
  console.log(`Using EventsAir credentials from org "${org.name}" (${org.id})`);
  console.log("Running READ-ONLY schema introspection — no data is written.\n");

  // 1. List every type name so we can see what the API exposes.
  let allTypeNames: string[] = [];
  try {
    const schema = await rawGraphQL<{ __schema: { types: { name: string; kind: string }[] } }>(
      creds,
      `query { __schema { types { name kind } } }`
    );
    allTypeNames = schema.__schema.types.map((t) => t.name).filter((n) => n && !n.startsWith("__"));
    console.log(`Schema exposes ${allTypeNames.length} types.`);
    const hinted = allTypeNames.filter((n) => NAME_HINT.test(n)).sort();
    console.log(`\nTypes matching registration/payment/category hints (${hinted.length}):`);
    console.log("  " + hinted.join("\n  "));
  } catch (err) {
    console.warn(
      `\n! Full __schema introspection failed (it may be disabled on EventsAir's API): ${
        err instanceof Error ? err.message : err
      }\n  Falling back to targeted __type probes on known/likely type names.`
    );
  }

  // 2. Always inspect the root Query, Event, and Contact types in full, then
  //    drill into the types referenced by their fields that match our hints.
  const seedTypes = ["Query", "Event", "Contact"];
  const visited = new Set<string>();
  const queue: string[] = [...seedTypes];

  // Seed with any hinted top-level type names discovered above.
  for (const n of allTypeNames) if (NAME_HINT.test(n)) queue.push(n);

  let depthBudget = 60; // safety cap on how many types we expand
  while (queue.length && depthBudget-- > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const t = await fetchType(creds, name);
    if (!t) continue;
    const children = printType(t);
    // Expand referenced object types that look relevant.
    for (const c of children) {
      if (!visited.has(c) && (NAME_HINT.test(c) || seedTypes.includes(c))) queue.push(c);
    }
  }

  console.log("\n\n✅ Introspection complete. Paste everything above back so we can finalize the mapping.");
}

main()
  .catch((err) => {
    console.error("Introspection failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
