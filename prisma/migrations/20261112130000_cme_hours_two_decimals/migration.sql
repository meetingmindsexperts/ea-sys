-- CME hours to two decimals (Nov 12, 2026). Owner: "cme should handle 2 digits
-- 3.75 or 5.25".
--
-- The three columns that hold CME / CPD hours were DECIMAL(4,1), so 3.75 was
-- stored as 3.8 without an error. They become DECIMAL(5,2): the same range
-- before the point (up to 999), two digits after it.
--
-- A WIDENING, and safe across the blue/green swap and a rollback:
--   - every value already stored fits unchanged (18.5 stays 18.5);
--   - the old code reads a Decimal, and whatever it writes fits: it sent any
--     number of decimals and Postgres rounded them to one, and now to two;
--   - no index, constraint or view depends on these columns.
-- Postgres rewrites the three tables for a change of scale. Event and
-- CertificateTemplate hold hundreds of rows and IssuedCertificate thousands, so
-- the lock is held for milliseconds. Acknowledged in
-- prisma/destructive-migrations-ack.txt, because the safety check flags every
-- ALTER COLUMN TYPE.
--
-- Idempotent: each column is altered only while its scale is below 2.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'Event'
               AND column_name = 'cmeHours' AND numeric_scale < 2) THEN
    ALTER TABLE "Event" ALTER COLUMN "cmeHours" TYPE DECIMAL(5,2);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'CertificateTemplate'
               AND column_name = 'cmeHours' AND numeric_scale < 2) THEN
    ALTER TABLE "CertificateTemplate" ALTER COLUMN "cmeHours" TYPE DECIMAL(5,2);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'IssuedCertificate'
               AND column_name = 'cmeHoursSnapshot' AND numeric_scale < 2) THEN
    ALTER TABLE "IssuedCertificate" ALTER COLUMN "cmeHoursSnapshot" TYPE DECIMAL(5,2);
  END IF;
END $$;
