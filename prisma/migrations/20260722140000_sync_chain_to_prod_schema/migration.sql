-- Sync the migration chain to the real production schema (July 22, 2026).
--
-- WHY THIS EXISTS
-- ---------------
-- Production only ever applies migrations INCREMENTALLY, and several features
-- were shipped to prod via `prisma db push` without a migration file — so the
-- chain, replayed from an EMPTY database, produces a schema ~250 SQL lines
-- short of prisma/schema.prisma. Missing entirely: the PromoCode family
-- (PromoCode / PromoCodeTicketType / PromoCodeRedemption + DiscountType enum),
-- DeviceToken, EventStats, RegistrationSerialCounter's serialId column,
-- Registration.serialId/originalPrice/discountAmount/promoCodeId,
-- Event.code/emailFromAddress/emailFromName, Invoice discount columns, the
-- InvoiceCounter org/year → event reshape, UserRole.MEMBER, the Title enum
-- cleanup (drop OTHER, reorder), and assorted FK/index/default changes.
--
-- That was discovered by the fresh-DB migration-replay CI check, and it
-- matters because the future PLATFORM instance (two-silo plan, see
-- docs/MULTI_TENANCY.md §0) gets a fresh database whose first command is a
-- full-chain `prisma migrate deploy`. Without this migration that database
-- would not match the code's schema.
--
-- HOW IT STAYS SAFE ON PROD
-- -------------------------
-- The ENTIRE body is gated on ONE sentinel: does "PromoCode" exist?
--   * On prod (and any db-push-shaped DB) PromoCode exists — the whole
--     migration is a single catalog lookup and RETURNs immediately. No locks
--     taken, no tables rewritten, no data touched. Verified by applying it to
--     a `prisma db push`-shaped seeded database and diffing schema dumps
--     before/after (byte-identical).
--   * On a chain-built fresh DB PromoCode is absent — the full drift script
--     applies. There is no partially-drifted third shape: a database either
--     came from db-push/prod (has everything) or from the chain (has none of
--     it), so one sentinel is safer than 58 per-statement guards.
--
-- The body below is `prisma migrate diff --from-url <replayed-db>
-- --to-schema-datamodel prisma/schema.prisma --script` VERBATIM (minus the
-- BEGIN/COMMIT around the Title rebuild — the migration already runs in a
-- transaction). Acceptance test: after fresh replay including this migration,
-- that same diff is EMPTY (asserted by the migration-replay CI job).
--
-- The destructive-looking statements (DROP CONSTRAINT / DROP COLUMN / ALTER
-- COLUMN TYPE) only ever execute against a fresh, EMPTY, chain-built database
-- — never against prod. Acknowledged in prisma/destructive-migrations-ack.txt.

DO $sync$
BEGIN
    IF to_regclass('public."PromoCode"') IS NOT NULL THEN
        -- Prod-shaped database: drift objects already present. No-op.
        RETURN;
    END IF;

    -- CreateEnum
    CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

    -- AlterEnum: Title loses OTHER and takes schema order (fresh DB only —
    -- the ALTER COLUMN TYPE table rewrites run against empty tables here)
    CREATE TYPE "Title_new" AS ENUM ('DR', 'MR', 'MRS', 'MS', 'PROF');
    ALTER TABLE "Attendee" ALTER COLUMN "title" TYPE "Title_new" USING ("title"::text::"Title_new");
    ALTER TABLE "Speaker" ALTER COLUMN "title" TYPE "Title_new" USING ("title"::text::"Title_new");
    ALTER TABLE "Contact" ALTER COLUMN "title" TYPE "Title_new" USING ("title"::text::"Title_new");
    ALTER TYPE "Title" RENAME TO "Title_old";
    ALTER TYPE "Title_new" RENAME TO "Title";
    DROP TYPE "public"."Title_old";

    -- AlterEnum
    ALTER TYPE "UserRole" ADD VALUE 'MEMBER';

    -- DropForeignKey
    ALTER TABLE "AbstractReviewer" DROP CONSTRAINT "AbstractReviewer_assignedById_fkey";
    ALTER TABLE "CertificateIssueRun" DROP CONSTRAINT "CertificateIssueRun_triggeredByUserId_fkey";
    ALTER TABLE "InvoiceCounter" DROP CONSTRAINT "InvoiceCounter_organizationId_fkey";
    ALTER TABLE "IssuedCertificate" DROP CONSTRAINT "IssuedCertificate_issuedByUserId_fkey";
    ALTER TABLE "Registration" DROP CONSTRAINT "Registration_ticketTypeId_fkey";
    ALTER TABLE "ScheduledEmail" DROP CONSTRAINT "ScheduledEmail_createdById_fkey";

    -- DropIndex
    DROP INDEX "Invoice_organizationId_sequenceNumber_type_key";
    DROP INDEX "InvoiceCounter_organizationId_type_year_key";
    DROP INDEX "Organization_slug_idx";

    -- AlterTable
    ALTER TABLE "AlertState" ALTER COLUMN "updatedAt" DROP DEFAULT;

    -- AlterTable
    ALTER TABLE "Event" ADD COLUMN "code" TEXT,
    ADD COLUMN "emailFromAddress" TEXT,
    ADD COLUMN "emailFromName" TEXT,
    ALTER COLUMN "timezone" SET DEFAULT 'Asia/Dubai';

    -- AlterTable
    ALTER TABLE "Invoice" ADD COLUMN "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN "discountCode" TEXT;

    -- AlterTable (fresh DB: InvoiceCounter is empty, NOT NULL add is safe)
    ALTER TABLE "InvoiceCounter" DROP COLUMN "organizationId",
    DROP COLUMN "year",
    ADD COLUMN "eventId" TEXT NOT NULL;

    -- AlterTable
    ALTER TABLE "PricingTier" ALTER COLUMN "updatedAt" DROP DEFAULT;

    -- AlterTable
    ALTER TABLE "Registration" ADD COLUMN "discountAmount" DECIMAL(10,2),
    ADD COLUMN "originalPrice" DECIMAL(10,2),
    ADD COLUMN "promoCodeId" TEXT,
    ADD COLUMN "serialId" INTEGER,
    ALTER COLUMN "ticketTypeId" DROP NOT NULL;

    -- AlterTable
    ALTER TABLE "SessionTopic" ALTER COLUMN "updatedAt" DROP DEFAULT;

    -- CreateTable
    CREATE TABLE "DeviceToken" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "platform" TEXT NOT NULL,
        "pushToken" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
    );

    -- CreateTable
    CREATE TABLE "PromoCode" (
        "id" TEXT NOT NULL,
        "eventId" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "description" TEXT,
        "discountType" "DiscountType" NOT NULL,
        "discountValue" DECIMAL(10,2) NOT NULL,
        "currency" TEXT,
        "maxUses" INTEGER,
        "maxUsesPerEmail" INTEGER DEFAULT 1,
        "usedCount" INTEGER NOT NULL DEFAULT 0,
        "validFrom" TIMESTAMP(3),
        "validUntil" TIMESTAMP(3),
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
    );

    -- CreateTable
    CREATE TABLE "PromoCodeTicketType" (
        "id" TEXT NOT NULL,
        "promoCodeId" TEXT NOT NULL,
        "ticketTypeId" TEXT NOT NULL,

        CONSTRAINT "PromoCodeTicketType_pkey" PRIMARY KEY ("id")
    );

    -- CreateTable
    CREATE TABLE "PromoCodeRedemption" (
        "id" TEXT NOT NULL,
        "promoCodeId" TEXT NOT NULL,
        "registrationId" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "originalPrice" DECIMAL(10,2) NOT NULL,
        "discountAmount" DECIMAL(10,2) NOT NULL,
        "finalPrice" DECIMAL(10,2) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "PromoCodeRedemption_pkey" PRIMARY KEY ("id")
    );

    -- CreateTable
    CREATE TABLE "EventStats" (
        "id" TEXT NOT NULL,
        "eventId" TEXT NOT NULL,
        "registrationsByStatus" JSONB NOT NULL DEFAULT '{}',
        "registrationsByPayment" JSONB NOT NULL DEFAULT '{}',
        "totalRegistrations" INTEGER NOT NULL DEFAULT 0,
        "checkedInCount" INTEGER NOT NULL DEFAULT 0,
        "speakersByStatus" JSONB NOT NULL DEFAULT '{}',
        "totalSpeakers" INTEGER NOT NULL DEFAULT 0,
        "agreementsSigned" INTEGER NOT NULL DEFAULT 0,
        "abstractsByStatus" JSONB NOT NULL DEFAULT '{}',
        "totalSessions" INTEGER NOT NULL DEFAULT 0,
        "totalTracks" INTEGER NOT NULL DEFAULT 0,
        "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,

        CONSTRAINT "EventStats_pkey" PRIMARY KEY ("id")
    );

    -- CreateIndex
    CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");
    CREATE UNIQUE INDEX "DeviceToken_userId_pushToken_key" ON "DeviceToken"("userId", "pushToken");
    CREATE INDEX "PromoCode_eventId_idx" ON "PromoCode"("eventId");
    CREATE INDEX "PromoCode_code_idx" ON "PromoCode"("code");
    CREATE UNIQUE INDEX "PromoCode_eventId_code_key" ON "PromoCode"("eventId", "code");
    CREATE INDEX "PromoCodeTicketType_promoCodeId_idx" ON "PromoCodeTicketType"("promoCodeId");
    CREATE INDEX "PromoCodeTicketType_ticketTypeId_idx" ON "PromoCodeTicketType"("ticketTypeId");
    CREATE UNIQUE INDEX "PromoCodeTicketType_promoCodeId_ticketTypeId_key" ON "PromoCodeTicketType"("promoCodeId", "ticketTypeId");
    CREATE UNIQUE INDEX "PromoCodeRedemption_registrationId_key" ON "PromoCodeRedemption"("registrationId");
    CREATE INDEX "PromoCodeRedemption_promoCodeId_idx" ON "PromoCodeRedemption"("promoCodeId");
    CREATE INDEX "PromoCodeRedemption_email_idx" ON "PromoCodeRedemption"("email");
    CREATE UNIQUE INDEX "EventStats_eventId_key" ON "EventStats"("eventId");
    -- 20260602100000 created these two as PARTIAL unique indexes
    -- (WHERE ... IS NOT NULL), which Prisma cannot represent — schema.prisma
    -- declares plain @@unique([runId, registrationId|speakerId]). The two are
    -- functionally identical (Postgres treats NULLs as distinct in composite
    -- unique indexes), so on the fresh-DB path we swap partial → full to match
    -- schema.prisma exactly; prod keeps its partial pair (no-op path above).
    DROP INDEX "CertificateIssueRunItem_runId_registrationId_key";
    DROP INDEX "CertificateIssueRunItem_runId_speakerId_key";
    CREATE UNIQUE INDEX "CertificateIssueRunItem_runId_registrationId_key" ON "CertificateIssueRunItem"("runId", "registrationId");
    CREATE UNIQUE INDEX "CertificateIssueRunItem_runId_speakerId_key" ON "CertificateIssueRunItem"("runId", "speakerId");
    CREATE UNIQUE INDEX "Invoice_eventId_sequenceNumber_type_key" ON "Invoice"("eventId", "sequenceNumber", "type");
    CREATE UNIQUE INDEX "InvoiceCounter_eventId_type_key" ON "InvoiceCounter"("eventId", "type");
    CREATE INDEX "Registration_promoCodeId_idx" ON "Registration"("promoCodeId");
    CREATE UNIQUE INDEX "Registration_eventId_serialId_key" ON "Registration"("eventId", "serialId");

    -- AddForeignKey
    ALTER TABLE "IssuedCertificate" ADD CONSTRAINT "IssuedCertificate_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE "CertificateIssueRun" ADD CONSTRAINT "CertificateIssueRun_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE "Registration" ADD CONSTRAINT "Registration_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    ALTER TABLE "AbstractReviewer" ADD CONSTRAINT "AbstractReviewer_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "PromoCodeTicketType" ADD CONSTRAINT "PromoCodeTicketType_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "PromoCodeTicketType" ADD CONSTRAINT "PromoCodeTicketType_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "PromoCodeRedemption" ADD CONSTRAINT "PromoCodeRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "PromoCodeRedemption" ADD CONSTRAINT "PromoCodeRedemption_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    ALTER TABLE "EventStats" ADD CONSTRAINT "EventStats_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

    -- RenameIndex
    ALTER INDEX "IssuedCert_event_template_registration_key" RENAME TO "IssuedCertificate_eventId_certificateTemplateId_registratio_key";
    ALTER INDEX "IssuedCert_event_template_speaker_key" RENAME TO "IssuedCertificate_eventId_certificateTemplateId_speakerId_key";
END $sync$;
