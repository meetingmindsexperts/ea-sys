-- Workshop + Symposium as first-class PROGRAM session types (organizer
-- request July 23, 2026). Unlike the break-item values, these carry speakers/
-- topics/track/Zoom exactly like SESSION — they render inside their assigned
-- track's column, never as full-width break bands.
--
-- Additive + idempotent: ADD VALUE IF NOT EXISTS is safe to re-run and
-- blue-green safe — old containers simply never write the new values.
ALTER TYPE "SessionType" ADD VALUE IF NOT EXISTS 'WORKSHOP';
ALTER TYPE "SessionType" ADD VALUE IF NOT EXISTS 'SYMPOSIUM';
