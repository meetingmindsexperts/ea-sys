/**
 * Data migration: Populate PricingTier from existing TicketType records.
 *
 * For each event:
 * 1. Group existing TicketType records by name
 * 2. For each unique name, keep one TicketType as the canonical registration type
 * 3. Create PricingTier records from each TicketType (using category as tier name)
 * 4. Update Registration.pricingTierId to point to the correct PricingTier
 * 5. Re-point Registration.ticketTypeId to the canonical TicketType
 * 6. Delete duplicate TicketType records
 *
 * Run: npx tsx scripts/migrate-pricing-tiers.ts
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const DEFAULT_REG_TYPES = ["Physician", "Allied Health", "Student", "Resident"];

async function main() {
  console.log("Starting pricing tier migration...\n");

  // Get all events
  const events = await db.event.findMany({ select: { id: true, name: true } });
  console.log(`Found ${events.length} events\n`);

  for (const event of events) {
    console.log(`\n=== Event: ${event.name} (${event.id}) ===`);

    // Get all ticket types for this event
    const ticketTypes = await db.ticketType.findMany({
      where: { eventId: event.id },
      include: { _count: { select: { registrations: true } } },
      orderBy: { createdAt: "asc" },
    });

    if (ticketTypes.length === 0) {
      console.log("  No ticket types, skipping");
      continue;
    }

    // Check if migration already done (PricingTier records exist)
    const existingTiers = await db.pricingTier.count({
      where: { ticketType: { eventId: event.id } },
    });
    if (existingTiers > 0) {
      console.log(`  Already has ${existingTiers} pricing tiers, skipping`);
      continue;
    }

    // Group ticket types by name
    const grouped = new Map<string, typeof ticketTypes>();
    for (const tt of ticketTypes) {
      const key = tt.name;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(tt);
    }

    console.log(`  ${ticketTypes.length} ticket types, ${grouped.size} unique names`);

    for (const [name, types] of grouped) {
      // Use the first one as the canonical registration type
      const canonical = types[0];
      console.log(`  Registration type: "${name}" (${types.length} variants)`);

      // Create PricingTier for each variant
      for (let i = 0; i < types.length; i++) {
        const tt = types[i];
        const tierName = tt.category || "Standard";

        const tier = await db.pricingTier.create({
          data: {
            ticketTypeId: canonical.id,
            name: tierName,
            price: tt.price,
            currency: tt.currency,
            quantity: tt.quantity,
            soldCount: tt.soldCount,
            maxPerOrder: tt.maxPerOrder,
            salesStart: tt.salesStart,
            salesEnd: tt.salesEnd,
            isActive: tt.isActive,
            requiresApproval: tt.requiresApproval,
            sortOrder: i,
          },
        });

        console.log(`    Created tier: "${tierName}" ($${tt.price}) -> ${tier.id}`);

        // Update registrations to point to this pricing tier
        // and ensure they point to the canonical ticket type
        const updated = await db.registration.updateMany({
          where: { ticketTypeId: tt.id },
          data: {
            pricingTierId: tier.id,
            ticketTypeId: canonical.id,
          },
        });

        if (updated.count > 0) {
          console.log(`    Updated ${updated.count} registrations`);
        }

        // Delete the duplicate TicketType (if not the canonical one)
        if (tt.id !== canonical.id) {
          await db.ticketType.delete({ where: { id: tt.id } });
          console.log(`    Deleted duplicate TicketType: ${tt.id}`);
        }
      }

      // Mark as default if it's one of the standard types
      const isDefault = DEFAULT_REG_TYPES.includes(name);
      await db.ticketType.update({
        where: { id: canonical.id },
        data: {
          isDefault,
          sortOrder: isDefault ? DEFAULT_REG_TYPES.indexOf(name) : 99,
        },
      });
    }

    // Create any missing default registration types
    for (let i = 0; i < DEFAULT_REG_TYPES.length; i++) {
      const typeName = DEFAULT_REG_TYPES[i];
      if (!grouped.has(typeName)) {
        await db.ticketType.create({
          data: {
            eventId: event.id,
            name: typeName,
            isDefault: true,
            isActive: true,
            sortOrder: i,
          },
        });
        console.log(`  Created default type: "${typeName}"`);
      }
    }
  }

  console.log("\n\nMigration complete!");
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
