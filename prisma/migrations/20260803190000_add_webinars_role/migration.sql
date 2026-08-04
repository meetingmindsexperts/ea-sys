-- Webinars team role (2026-08-03): full control of WEBINAR-type events +
-- ONSITE-equivalent desk on assigned conferences. Additive + idempotent.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'WEBINARS';
